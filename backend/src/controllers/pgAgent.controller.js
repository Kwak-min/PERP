import { z } from "zod";

import { db } from "../config/db.js";
import { pgQuery } from "../config/pg.js";
import { PRESETS, presetFor } from "../config/agent-tools.js";
import { currentUser } from "../middleware/auth.js";
import { resolvePgCompanyPrincipal } from "../middleware/pgAccess.js";
import { pgEnabledFeatures } from "../middleware/features.js";
import { getScoped, insert, newId, nowIso, update } from "../models/base.js";
import { completeForUser } from "../services/ai-key.service.js";
import { requireTurnKey } from "../services/agent-run.service.js";
import { agentChat, requestKnowledgeMode } from "../services/agent-chat.service.js";
import { localDate } from "../services/analytics-contract.service.js";
import { canReadPgApproval } from "../services/pg-approval-read-policy.service.js";
import { listPgDocuments } from "../services/pg-documents.service.js";
import * as rag from "../services/rag.service.js";
import { ApiError, notFound } from "../utils/errors.js";

const chatSchema = z.object({
  message: z.string().min(1),
  conversation_id: z.string().nullable().optional(),
  data_class: z.enum(["public", "internal", "personal", "sensitive", "confidential"]).default("internal"),
  vault_mode: z.enum(["off", "on"]).optional(),
  agent_mode: z.boolean().optional(),
  knowledge_mode: z.enum(["personal", "company"]).optional(),
  attachment_ids: z.array(z.string().uuid()).max(5).optional(),
  cloud_consent: z.object({ token: z.string().min(1).max(10000), confirmed: z.literal(true) }).strict().optional(),
}).strict();
const memorySchema = z.object({ key: z.string().trim().min(1).max(200), value: z.string().trim().max(2000).default("") }).strict();
const credentialLike = (value) => [/비밀번호/i, /password/i, /api[_ -]?key/i, /secret/i, /주민등록번호/, /계좌\s*비밀/, /\b\d{6}-\d{7}\b/]
  .some((pattern) => pattern.test(value));

const termsOf = (query) => query.replace(/,/g, " ").split(/\s+/).filter((term) => term.length >= 2);
const dateOnly = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").slice(0, 10);
const scoreRows = (rows, query, contentOf, limit = 5) => {
  const terms = termsOf(query).map((term) => term.toLowerCase());
  return rows.map((row) => [terms.filter((term) => contentOf(row).toLowerCase().includes(term)).length, row])
    .filter(([score]) => score > 0)
    .sort((left, right) => right[0] - left[0])
    .slice(0, limit);
};

function canReadCompanySource(principal, permission, menu, module) {
  return principal.has(permission) && principal.has(menu) && principal.modules.includes(module);
}

async function contextFor(principal, query, vaultMode) {
  const documents = canReadCompanySource(principal, "document.read", "menu.documents", "documents")
    ? await listPgDocuments({ query: pgQuery }, principal, { limit: 1000, knowledgeMode: vaultMode === "on" ? "personal" : "company" }) : [];
  const citations = scoreRows(documents, query, (row) => `${row.title} ${row.content_md}`).map(([score, row]) => ({
    type: "document", id: String(row.id), title: row.title, excerpt: row.content_md.slice(0, 200),
    date: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ""),
    link: `/documents/${row.id}`, score, sensitivity: row.sensitivity,
  }));
  if (vaultMode === "on") {
    const notes = (await pgQuery(
      `SELECT n.id,n.title,COALESCE(n.content_md,'') AS content_md,n.updated_at
         FROM notes.notes n JOIN notes.vaults v ON v.id=n.vault_id
        WHERE v.owner_id=$1 ORDER BY n.updated_at DESC,n.id LIMIT 1000`,
      [principal.userId],
    )).rows;
    citations.push(...scoreRows(notes, query, (row) => `${row.title} ${row.content_md}`).map(([score, row]) => ({
      type: "vault_note", id: String(row.id), title: row.title, excerpt: row.content_md.slice(0, 200),
      date: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ""),
      link: `/vault/${row.id}`, score, sensitivity: "personal",
    })));
  }
  const memories = (await pgQuery(
    `SELECT key,value FROM ai.agent_memory WHERE user_id=$1 ORDER BY id DESC LIMIT 10`,
    [principal.userId],
  )).rows.map((row) => ({ content: `${row.key}: ${row.value ?? ""}`, sensitivity: "internal" }));
  return { citations, memories };
}

function providerScope(req, principal) {
  return {
    tenantId: `pg:${principal.companyId}`,
    orgId: `pg:${principal.companyId}`,
    userId: currentUser(req).id,
    roles: principal.roles,
  };
}

export async function operationContext(req) {
  const principal = await resolvePgCompanyPrincipal(req);
  principal.require("agent.chat");
  principal.require("menu.agent");
  if (!principal.modules.includes("agent")) throw new ApiError("MODULE_DISABLED", "AI 모듈이 비활성화되어 있습니다.");
  return { source: "pg", request: req, principal, credentialPrincipal: providerScope(req, principal),
    actorId: String(principal.userId), workspaceId: String(principal.companyId), requestId: req.requestId,
    knowledgeMode: requestKnowledgeMode(req) };
}

export async function chat(req, res) {
  const principal = await resolvePgCompanyPrincipal(req);
  const payload = chatSchema.parse(req.body);
  if (payload.agent_mode) {
    requireTurnKey(req);
    return agentChat(await operationContext(req), payload, res);
  }
  if (payload.knowledge_mode || payload.attachment_ids || payload.cloud_consent) throw new ApiError("VALIDATION_ERROR", "지식 범위와 첨부는 Agent 모드에서 사용하세요.");
  const scope = providerScope(req, principal);
  let conversation = null;
  if (payload.conversation_id) {
    conversation = getScoped("ai_conversation", scope, payload.conversation_id, "conversation");
    if (conversation.user_id !== scope.userId) throw notFound("conversation");
  }
  const vaultMode = payload.vault_mode ?? conversation?.vault_mode ?? "off";
  if (conversation && payload.vault_mode && payload.vault_mode !== conversation.vault_mode) {
    throw new ApiError("CONFLICT", "대화의 개인 Vault 범위는 시작 후 변경할 수 없습니다. 새 대화를 시작하세요.");
  }
  if (!conversation) {
    conversation = insert("ai_conversation", {
      tenant_id: scope.tenantId, org_id: scope.orgId, user_id: scope.userId,
      title: payload.message.slice(0, 60), vault_mode: vaultMode, created_by: scope.userId,
    });
  }
  const { citations, memories } = await contextFor(principal, payload.message, vaultMode);
  const dataClass = rag.effectiveDataClass(payload.data_class, citations, memories);
  const result = await completeForUser(scope, {
    dataClass,
    system: `${rag.SYSTEM_POLICY}\n\n${rag.buildContext(citations, memories)}`,
    user: payload.message,
  });
  const answer = {
    conclusion: result.text ? result.text.slice(0, 2000) : "근거가 되는 데이터를 찾지 못했습니다.",
    evidence: citations,
    related_data: { memory_used: memories.length, citation_count: citations.length,
      vault_notes_used: citations.filter((citation) => citation.type === "vault_note").length },
    uncertainty: citations.length === 0 ? "근거 문서 없음 - 답변 신뢰도가 낮습니다" : "근거 문서 기반",
    next_actions: ["관련 근거를 확인하기", "필요하면 오늘 브리핑을 요청하기"],
    executable: false, required_approval: null, grounded: citations.length > 0,
  };
  insert("ai_message", { tenant_id: scope.tenantId, conversation_id: conversation.id, role: "user",
    content: payload.message, created_by: scope.userId });
  insert("ai_message", { tenant_id: scope.tenantId, conversation_id: conversation.id, role: "assistant",
    content: answer.conclusion, citations: JSON.stringify(citations), answer_json: JSON.stringify(answer), created_by: scope.userId });
  update("ai_conversation", conversation.id, { cost_micro: conversation.cost_micro + result.cost_micro });
  db().prepare(`INSERT INTO ai_request_log
    (id,request_id,user_id,tenant_id,model,provider,prompt_tokens,completion_tokens,cost_micro,latency_ms,
     tool_calls,citations,approval_id,result,error,data_class,fallback_from,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'[]',?,NULL,?,?,?,NULL,?)`).run(
    newId(), req.requestId ?? "", scope.userId, scope.tenantId, result.model, result.provider,
    result.prompt_tokens, result.completion_tokens, result.cost_micro, result.latency_ms,
    JSON.stringify(citations.map((citation) => citation.id)), result.error ? "error" : "ok", result.error ?? null, dataClass, nowIso(),
  );
  res.json({ conversation_id: conversation.id, answer, model: result.model, provider: result.provider,
    latency_ms: result.latency_ms, ai_generated: true, generated_at: nowIso(),
    scope: { vault_mode: vaultMode, personal_vault_used: vaultMode === "on" && citations.some((citation) => citation.type === "vault_note") } });
}

async function pendingRows(principal) {
  const rows = (await pgQuery(`SELECT ar.id,ar.requester_id,COALESCE(ar.title,ar.request_type) AS title,
    ar.request_type,ar.status,ar.created_at,ar.workflow_locked
    FROM org.approval_requests ar WHERE ar.company_id=$1 AND ar.status='pending'
    ORDER BY ar.created_at DESC,ar.id DESC LIMIT 50`, [principal.companyId])).rows;
  return rows.filter((row) => canReadPgApproval(principal, row));
}

export async function pendingApprovals(req, res) {
  const principal = await resolvePgCompanyPrincipal(req);
  principal.require("approval.decide");
  principal.require("menu.approvals");
  if (!principal.modules.includes("approvals")) throw new ApiError("MODULE_DISABLED", "이 회사에서 결재 모듈이 비활성화되어 있습니다");
  const rows = await pendingRows(principal);
  res.json({ items: rows.map((row) => ({
    id: String(row.id), title: row.title, status: row.status, version: Number(row.version ?? 1),
    requester_id: row.requester_id == null ? null : String(row.requester_id),
    requires_reauth: false, confirm_self_decision: String(row.requester_id) === String(principal.userId), blocked: false,
  })) });
}

export async function listMemory(req, res) {
  const principal = await resolvePgCompanyPrincipal(req);
  const { rows } = await pgQuery(`SELECT id,key,value FROM ai.agent_memory WHERE user_id=$1 ORDER BY id DESC`, [principal.userId]);
  res.json({ items: rows.map((row) => ({ id: String(row.id), key: row.key, value: row.value ?? "" })) });
}

export async function createMemory(req, res) {
  const principal = await resolvePgCompanyPrincipal(req);
  const payload = memorySchema.parse(req.body);
  if (credentialLike(`${payload.key} ${payload.value}`)) throw new ApiError("VALIDATION_ERROR", "자격증명으로 보이는 값은 AI 기억에 저장할 수 없습니다.");
  const { rows } = await pgQuery(`INSERT INTO ai.agent_memory(company_id,user_id,key,value) VALUES($1,$2,$3,$4)
    ON CONFLICT(user_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now() RETURNING id`,
  [principal.companyId, principal.userId, payload.key, payload.value || null]);
  res.status(201).json({ id: String(rows[0].id) });
}

export async function deleteMemory(req, res) {
  const principal = await resolvePgCompanyPrincipal(req);
  const id = z.string().regex(/^[1-9]\d*$/).parse(req.params.id);
  const { rows } = await pgQuery(`DELETE FROM ai.agent_memory WHERE id=$1 AND user_id=$2 RETURNING id`, [id, principal.userId]);
  if (!rows[0]) throw notFound("agent memory");
  res.json({ id: String(rows[0].id), deleted: true });
}

export function briefTaskItems(tasks, now = new Date()) {
  const today = localDate(now, "Asia/Seoul");
  const overdue = tasks.filter((row) => row.due_on && dateOnly(row.due_on) < today).slice(0, 5).map((task) => ({
    kind: "overdue_task", title: task.title, priority: "high",
    evidence: { type: "task", id: String(task.id), link: `/tasks/${task.id}`, date: dateOnly(task.due_on) },
  }));
  const dueToday = tasks.filter((row) => row.due_on && dateOnly(row.due_on) === today).slice(0, 5).map((task) => ({
    kind: "today_task", title: task.title, priority: "normal",
    evidence: { type: "task", id: String(task.id), link: `/tasks/${task.id}`, date: dateOnly(task.due_on) },
  }));
  return [...overdue, ...dueToday];
}

export async function brief(req, res) {
  const principal = await resolvePgCompanyPrincipal(req);
  const tasks = canReadCompanySource(principal, "task.read", "menu.projects", "tasks") ? (await pgQuery(`SELECT t.id,t.title,to_char(t.due_on,'YYYY-MM-DD') AS due_on,t.status
    FROM project.tasks t JOIN project.projects p ON p.id=t.project_id
    WHERE p.company_id=$1 AND t.assignee_id=$2 AND t.status NOT IN ('done','completed','cancelled')
    ORDER BY t.due_on,t.id LIMIT 200`, [principal.companyId, principal.userId])).rows : [];
  const features = await pgEnabledFeatures(principal.companyId, principal.modules);
  const approvals = principal.has("approval.decide") && principal.has("menu.approvals") && features.includes("approvals") ? await pendingRows(principal) : [];
  const items = briefTaskItems(tasks);
  if (approvals.length) items.push({ kind: "approval", title: `승인 대기 ${approvals.length}건`, priority: "high",
    evidence: { type: "approval", link: "/approvals" } });
  const preset = presetFor(principal.roles);
  res.json({ preset, preset_label: PRESETS[preset].label, sections: PRESETS[preset].brief, items,
    ai_generated: true, generated_at: nowIso(), grounded: true });
}
