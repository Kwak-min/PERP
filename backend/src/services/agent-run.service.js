import { createHash, randomUUID } from "node:crypto";

import { db } from "../config/db.js";
import { pgQuery } from "../config/pg.js";
import { ApiError, notFound } from "../utils/errors.js";

export function requireTurnKey(request) {
  const key = request.get("idempotency-key");
  if (typeof key !== "string" || !/^[\x21-\x7e]{1,200}$/.test(key)) {
    throw new ApiError("VALIDATION_ERROR", "Agent 요청에는 유효한 Idempotency-Key가 필요합니다.");
  }
  return key;
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  }
  return value;
}

export const turnHash = value => createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");

export async function getRun(context, id) {
  const p = context.principal;
  const row = context.source === "pg"
    ? (await pgQuery("SELECT * FROM public.agent_runs WHERE id=$1 AND company_id=$2 AND actor_id=$3 AND knowledge_mode=$4",
      [id, p.companyId, p.userId, context.knowledgeMode])).rows[0]
    : db().prepare("SELECT * FROM agent_runs WHERE id=? AND tenant_id=? AND org_id=? AND actor_id=? AND knowledge_mode=?")
      .get(id, p.tenantId, p.orgId, p.userId, context.knowledgeMode);
  if (!row) throw notFound("agent run");
  return row;
}

export async function findRun(context, key) {
  const p = context.principal;
  const row = context.source === "pg"
    ? (await pgQuery(`SELECT id FROM public.agent_runs
      WHERE company_id=$1 AND actor_id=$2 AND idempotency_key=$3 AND knowledge_mode=$4`,
    [p.companyId, p.userId, key, context.knowledgeMode])).rows[0] ?? null
    : db().prepare(`SELECT id FROM agent_runs
      WHERE tenant_id=? AND org_id=? AND actor_id=? AND idempotency_key=? AND knowledge_mode=?`)
      .get(p.tenantId, p.orgId, p.userId, key, context.knowledgeMode) ?? null;
  if (row) return row;
  const collision = context.source === "pg"
    ? (await pgQuery(`SELECT 1 FROM public.agent_runs
      WHERE company_id=$1 AND actor_id=$2 AND idempotency_key=$3 AND knowledge_mode<>$4`,
    [p.companyId, p.userId, key, context.knowledgeMode])).rows[0]
    : db().prepare(`SELECT 1 FROM agent_runs
      WHERE tenant_id=? AND org_id=? AND actor_id=? AND idempotency_key=? AND knowledge_mode<>?`)
      .get(p.tenantId, p.orgId, p.userId, key, context.knowledgeMode);
  if (collision) throw new ApiError("IDEMPOTENCY_CONFLICT", "다른 지식 범위에서 사용한 요청 키입니다.");
  return null;
}

export async function claimRun(context, payload, key) {
  const p = context.principal;
  const id = randomUUID();
  const hash = turnHash({ ...payload, knowledge_mode: context.knowledgeMode });
  const now = new Date().toISOString();
  let row;
  if (context.source === "pg") {
    row = (await pgQuery(`INSERT INTO public.agent_runs
      (id,company_id,actor_id,idempotency_key,request_hash,status,created_at,updated_at,knowledge_mode)
      VALUES($1,$2,$3,$4,$5,'running',$6,$6,$7)
      ON CONFLICT(company_id,actor_id,idempotency_key) DO NOTHING RETURNING *`,
    [id, p.companyId, p.userId, key, hash, now, context.knowledgeMode])).rows[0];
    if (!row) row = (await pgQuery(
      "SELECT * FROM public.agent_runs WHERE company_id=$1 AND actor_id=$2 AND idempotency_key=$3 AND knowledge_mode=$4",
      [p.companyId, p.userId, key, context.knowledgeMode])).rows[0];
  } else {
    db().prepare(`INSERT INTO agent_runs
      (id,tenant_id,org_id,actor_id,idempotency_key,request_hash,status,created_at,updated_at,knowledge_mode)
      VALUES(?,?,?,?,?,?,'running',?,?,?)
      ON CONFLICT(tenant_id,org_id,actor_id,idempotency_key) DO NOTHING`)
      .run(id, p.tenantId, p.orgId, p.userId, key, hash, now, now, context.knowledgeMode);
    row = db().prepare("SELECT * FROM agent_runs WHERE tenant_id=? AND org_id=? AND actor_id=? AND idempotency_key=? AND knowledge_mode=?")
      .get(p.tenantId, p.orgId, p.userId, key, context.knowledgeMode);
  }
  if (!row || row.request_hash !== hash) {
    throw new ApiError("IDEMPOTENCY_CONFLICT", "같은 요청 키로 다른 대화를 보낼 수 없습니다.");
  }
  if (row.id === id) return { run: row, receipt: null };
  if (row.status === "completed" && row.response_json) {
    return { run: row, receipt: typeof row.response_json === "string" ? JSON.parse(row.response_json) : row.response_json };
  }
  const active = row.status === "running" && Date.now() - new Date(row.updated_at).getTime() < 65000;
  throw new ApiError(active ? "AGENT_RUN_IN_PROGRESS" : "AGENT_RUN_INCOMPLETE",
    active ? "같은 요청이 처리 중입니다. 원래 요청 키를 유지하세요." : "완료되지 않은 요청입니다. 작업 목록을 확인한 뒤 새 요청을 시작하세요.",
    { run_id: row.id, conversation_id: row.conversation_id, state: active ? "running" : "incomplete" }, 409);
}

export async function bindRunConversation(context, id, conversationId) {
  const p = context.principal;
  const now = new Date().toISOString();
  if (context.source === "pg") {
    await pgQuery(`UPDATE public.agent_runs SET conversation_id=$1,updated_at=$2
      WHERE id=$3 AND company_id=$4 AND actor_id=$5 AND status='running' AND knowledge_mode=$6`,
    [conversationId, now, id, p.companyId, p.userId, context.knowledgeMode]);
  } else {
    db().prepare(`UPDATE agent_runs SET conversation_id=?,updated_at=?
      WHERE id=? AND tenant_id=? AND org_id=? AND actor_id=? AND status='running' AND knowledge_mode=?`)
      .run(conversationId, now, id, p.tenantId, p.orgId, p.userId, context.knowledgeMode);
  }
}

export async function finishRun(context, id, receipt, error = null) {
  const p = context.principal;
  const status = error ? "failed" : "completed";
  const response = receipt ? JSON.stringify(receipt) : null;
  // 공급자 응답·예외 원문·비밀번호는 실패 기록에 저장하지 않는다.
  const failure = error ? JSON.stringify({ code: error.code ?? "INTERNAL" }) : null;
  const now = new Date().toISOString();
  if (context.source === "pg") {
    await pgQuery(`UPDATE public.agent_runs SET status=$1,response_json=$2,error_json=$3,updated_at=$4
      WHERE id=$5 AND company_id=$6 AND actor_id=$7 AND status='running' AND knowledge_mode=$8`,
    [status, response, failure, now, id, p.companyId, p.userId, context.knowledgeMode]);
  } else {
    db().prepare(`UPDATE agent_runs SET status=?,response_json=?,error_json=?,updated_at=?
      WHERE id=? AND tenant_id=? AND org_id=? AND actor_id=? AND status='running' AND knowledge_mode=?`)
      .run(status, response, failure, now, id, p.tenantId, p.orgId, p.userId, context.knowledgeMode);
  }
}
