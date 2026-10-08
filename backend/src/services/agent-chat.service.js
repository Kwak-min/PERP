import { db, transaction } from "../config/db.js";
import { env } from "../config/env.js";
import { getScoped, insert, newId, nowIso } from "../models/base.js";
import { ApiError, notFound } from "../utils/errors.js";
import { catalog, query } from "./agent-capabilities.service.js";
import { getOperation, propose } from "./agent-operation.service.js";
import { runAgent } from "./agent-loop.service.js";
import { agentTurnTarget, completeTurnForUser } from "./ai-key.service.js";
import { classifyAgentContent } from "./ai-provider.service.js";
import { bindRunConversation, claimRun, findRun, getRun, finishRun, requireTurnKey, turnHash } from "./agent-run.service.js";
import { prepareKnowledge, approveKnowledgeConsent, assertKnowledgeDispatch, extractAndSaveKnowledge,
  assertConversationKnowledgeMode } from "./agent-knowledge.service.js";
import { evidenceView, strongestClassification, untrustedKnowledge } from "./agent-knowledge-policy.service.js";
import { assertKnowledgeReplaySources } from "./agent-knowledge-prepare.service.js";
import { localDate } from "./analytics-contract.service.js";
import * as rag from "./rag.service.js";

export function requestKnowledgeMode(request) {
  const mode = (request.method === "GET" ? request.query?.knowledge_mode : request.body?.knowledge_mode) ?? "personal";
  if (mode !== "personal" && mode !== "company") throw new ApiError("VALIDATION_ERROR", "지식 범위를 선택하세요.");
  return mode;
}

async function protectedResultPolicy(signal) {
  try {
    const response = await fetch(`${env.ollamaBaseUrl.replace(/\/$/, "")}/v1/models`, {
      redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
    });
    if (!response.ok) { await response.body?.cancel(); return "ui_only"; }
    const models = await response.json();
    return models.data?.some(model => model.id === env.localModel) ? "local" : "ui_only";
  } catch {
    signal.throwIfAborted();
    return "ui_only";
  }
}

function conversationFor(context, id) {
  const scope = context.credentialPrincipal;
  const conversation = getScoped("ai_conversation", scope, id, "conversation");
  if (conversation.user_id !== scope.userId) throw notFound("conversation");
  assertConversationKnowledgeMode(conversation, context.knowledgeMode);
  return conversation;
}

async function reauthorizeReceipt(context, receipt) {
  conversationFor(context, receipt.response.conversation_id);
  await assertKnowledgeReplaySources(context, receipt.sources);
  const capabilities = await catalog(context);
  for (const activity of receipt.response.tool_activity) {
    if (activity.tool && !capabilities.some(item => item.name === activity.tool && item.callable)) {
      throw new ApiError("PERMISSION_DENIED", "이전 결과에 접근할 현재 권한이 없습니다.");
    }
  }
  for (const action of receipt.response.actions) await getOperation(context, action.id);
  for (const check of receipt.queries) {
    const input = check.tool === "get.project_money" ? { project_id: check.evidence[0]?.id }
      : check.tool === "get.brief" ? {} : { limit: 50 };
    const current = await query(context, check.tool, input);
    const visible = new Set(current.evidence.map(item => turnHash(item)));
    if (!check.evidence.every(item => visible.has(turnHash(item)))) {
      throw new ApiError("CONFLICT", "조회 범위가 변경되었습니다. 새 요청으로 현재 데이터를 확인하세요.");
    }
  }
}

export async function historyFor(context, conversationId) {
  if (!conversationId) return [];
  conversationFor(context, conversationId);
  const scope = context.credentialPrincipal;
  const rows = db().prepare(`SELECT * FROM ai_message WHERE tenant_id=? AND conversation_id=? AND created_by=?
    AND deleted_at IS NULL AND role IN ('user','assistant')
    AND COALESCE(json_extract(answer_json,'$.knowledge_mode'),'personal')=?
    ORDER BY rowid DESC LIMIT 20`).all(scope.tenantId, conversationId, scope.userId, context.knowledgeMode).reverse();
  const checked = new Set();
  const evidence = [];
  for (const row of rows) {
    const metadata = JSON.parse(row.answer_json);
    if (metadata.run_id && !checked.has(metadata.run_id)) {
      const run = await getRun(context, metadata.run_id);
      if (run.status !== "completed" || !run.response_json) throw new ApiError("CONFLICT", "완료되지 않은 대화 이력입니다.");
      await reauthorizeReceipt(context, typeof run.response_json === "string" ? JSON.parse(run.response_json) : run.response_json);
      checked.add(metadata.run_id);
    }
    evidence.push(evidenceView({ id: row.id, kind: "history", scope: context.knowledgeMode,
      title: row.role === "user" ? "사용자 메시지" : "Agent 답변",
      text: metadata.model_transcript ? JSON.stringify(metadata.model_transcript) : `${row.role}: ${row.content}`,
      version: row.version, classification: metadata.classification ?? "confidential" }));
  }
  return evidence;
}

export function knowledgeProviderTarget(context, prepared, history) {
  return agentTurnTarget(context.credentialPrincipal, {
    messages: [{ role: "system", content: prepared.context_text }, { role: "user", content: untrustedKnowledge(history) }],
    classification: strongestClassification([prepared.classification, ...history.map(item => item.classification)]),
  });
}

export async function agentChat(context, payload, response) {
  const request = context.request;
  const key = requireTurnKey(request);
  const scope = context.credentialPrincipal;
  const cancellation = new AbortController();
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(60000)]);
  const abort = () => cancellation.abort();
  const disconnect = () => { if (!response.writableEnded) abort(); };
  request.once("aborted", abort);
  response.once("close", disconnect);
  response.set("Cache-Control", "private, no-store");
  let run;
  let owned = false;
  try {
    let conversation = payload.conversation_id ? conversationFor(context, payload.conversation_id) : null;
    const { cloud_consent: approval, ...semanticPayload } = payload;
    const knowledgeInput = { message: payload.message, attachment_ids: payload.attachment_ids ?? [], classification: payload.data_class };
    if (await findRun(context, key)) {
      const { receipt } = await claimRun(context, semanticPayload, key);
      await reauthorizeReceipt(context, receipt);
      response.json(receipt.response);
      return;
    }
    const prepared = await prepareKnowledge(context, knowledgeInput);
    const history = await historyFor(context, payload.conversation_id);
    const target = knowledgeProviderTarget(context, prepared, history);
    const dispatchScope = { prepared, message: payload.message, conversation_id: payload.conversation_id ?? null, history };
    const receipt = approval && target.external ? await approveKnowledgeConsent(context, approval, { ...dispatchScope, ...target }) : undefined;
    await assertKnowledgeDispatch(context, { ...dispatchScope, ...target, receipt });
    signal.throwIfAborted();
    const claimed = await claimRun(context, semanticPayload, key);
    if (claimed.receipt) throw new ApiError("AGENT_RUN_IN_PROGRESS", "같은 요청의 결과를 원래 키로 다시 확인하세요.", {}, 409);
    run = claimed.run;
    owned = true;
    if (!conversation) conversation = insert("ai_conversation", {
      tenant_id: scope.tenantId, org_id: scope.orgId, user_id: scope.userId,
      project_id: payload.project_id ?? null, title: payload.message.slice(0, 60),
      knowledge_mode: context.knowledgeMode,
      vault_mode: context.knowledgeMode === "personal" ? "on" : "off", created_by: scope.userId,
    });
    await bindRunConversation(context, run.id, conversation.id);
    run.conversation_id = conversation.id;
    const citations = prepared.evidence.map(item => ({ type: item.kind === "note" ? "vault_note" : item.kind,
      id: item.id, title: item.title, ...(item.link ? { link: item.link } : {}), sensitivity: item.classification }));
    const sourceClass = strongestClassification([prepared.classification, ...history.map(item => item.classification)]);
    const now = new Date();
    const messages = [
      { role: "system", content: JSON.stringify({ current_time: now.toISOString(), business_timezone: "Asia/Seoul", business_date: localDate(now, "Asia/Seoul") }) },
      { role: "system", content: `${rag.SYSTEM_POLICY}\n\n${prepared.context_text}\n\n${untrustedKnowledge(history)}` },
      { role: "user", content: payload.message },
    ];
    const classification = classifyAgentContent(messages, sourceClass);
    context.protectedResultPolicy = await protectedResultPolicy(signal);
    const usage = { prompt_tokens: 0, completion_tokens: 0, cost_micro: 0, latency_ms: 0 };
    let modelTranscript = [];
    let extracting = false;
    const completeTurn = async options => {
      const turn = await completeTurnForUser(scope, {
        ...options,
        beforeDispatch: async actual => {
          const currentHistory = await historyFor(context, payload.conversation_id);
          if (turnHash(currentHistory) !== turnHash(history)) throw new ApiError("KNOWLEDGE_SCOPE_CHANGED", "대화 이력이 변경되었습니다.", {}, 409);
          await assertKnowledgeDispatch(context, { ...dispatchScope, ...actual, history: currentHistory, receipt });
        },
      });
      if (!extracting) {
        modelTranscript = structuredClone(options.messages.filter(message => message.role === "assistant" || message.role === "tool"));
      }
      for (const name of Object.keys(usage)) usage[name] += turn.usage[name];
      return turn;
    };
    const result = await runAgent(context, {
      run_id: run.id, conversation_id: conversation.id, messages, classification, signal,
    }, {
      catalog, query, propose,
      completeTurn,
    });
    signal.throwIfAborted();
    modelTranscript.push({ role: "assistant", content: result.content });
    const protectedResults = result.protected_results ?? [];
    const withheld = new Set(protectedResults.map(item => item.tool_call_id));
    const evidence = [...citations, ...result.tool_activity.filter(item => !withheld.has(item.tool_call_id)).flatMap(item => item.evidence ?? [])]
      .map(item => ({ ...item, type: item.type ?? item.source ?? item.kind ?? "tool" }));
    const queries = result.tool_activity.filter(item => item.stage === "query").map(item => ({
      tool: item.tool,
      evidence: protectedResults.find(entry => entry.tool_call_id === item.tool_call_id)?.evidence ?? item.evidence ?? [],
    }));
    extracting = true;
    const knowledgeSaves = await extractAndSaveKnowledge(context, {
      run_id: run.id, message: payload.message, prepared, signal,
    }, { completeTurn });
    if (protectedResults.length) knowledgeSaves.push({ status: "skipped", scope: context.knowledgeMode,
      code: "PROTECTED_RESULTS_NOT_EXTRACTED", ai_generated: true, review_status: "unreviewed" });
    const answer = {
      conclusion: result.content.slice(0, 8000), evidence,
      related_data: { memory_used: citations.filter(item => item.type === "memory").length, citation_count: evidence.length,
        vault_notes_used: citations.filter(item => item.type === "vault_note").length },
      uncertainty: evidence.length ? "실제 조회 결과 기반" : "조회 근거 없음",
      next_actions: [], executable: false, required_approval: null, grounded: evidence.length > 0,
    };
    const final = {
      conversation_id: conversation.id, run_id: run.id, answer,
      tool_activity: result.tool_activity, actions: result.actions, protected_results: protectedResults,
      knowledge_saves: knowledgeSaves,
      classification: result.classification, content_classification: result.content_classification ?? result.classification,
      model: result.model, provider: result.provider, latency_ms: usage.latency_ms,
      ai_generated: true, generated_at: nowIso(),
      scope: { knowledge_mode: context.knowledgeMode, vault_mode: context.knowledgeMode === "personal" ? "on" : "off",
        personal_vault_used: citations.some(item => item.type === "vault_note") },
    };
    transaction(() => {
      const metadata = { classification: result.content_classification ?? result.classification, knowledge_mode: context.knowledgeMode, run_id: run.id };
      insert("ai_message", { tenant_id: scope.tenantId, conversation_id: conversation.id, role: "user",
        content: payload.message, answer_json: JSON.stringify(metadata), created_by: scope.userId });
      insert("ai_message", { tenant_id: scope.tenantId, conversation_id: conversation.id, role: "assistant",
        content: answer.conclusion, citations: JSON.stringify(evidence),
        answer_json: JSON.stringify({ ...answer, ...metadata, model_transcript: modelTranscript }),
        created_by: scope.userId });
      db().prepare("UPDATE ai_conversation SET cost_micro=cost_micro+?,updated_at=? WHERE id=? AND tenant_id=? AND org_id=? AND user_id=?")
        .run(usage.cost_micro, nowIso(), conversation.id, scope.tenantId, scope.orgId, scope.userId);
      db().prepare(`INSERT INTO ai_request_log
        (id,request_id,user_id,tenant_id,model,provider,prompt_tokens,completion_tokens,cost_micro,latency_ms,
         tool_calls,citations,approval_id,result,error,data_class,fallback_from,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,'ok',NULL,?,NULL,?)`).run(
        newId(), context.requestId ?? "", scope.userId, scope.tenantId, result.model, result.provider,
        usage.prompt_tokens, usage.completion_tokens, usage.cost_micro, usage.latency_ms,
        JSON.stringify(result.tool_activity.map(item => ({ tool: item.tool, stage: item.stage, status: item.status }))),
        JSON.stringify(evidence.map(item => item.id)), result.classification, nowIso(),
      );
    })();
    await finishRun(context, run.id, { response: final, queries,
      sources: prepared.evidence.map(item => ({ id: item.id, content_hash: item.content_hash, version: item.version })) });
    response.json(final);
  } catch (error) {
    if (signal.aborted) error = new ApiError("SERVICE_UNAVAILABLE", "Agent 요청이 취소되었거나 제한 시간을 초과했습니다.", { reason: "aborted" });
    if (owned) {
      await finishRun(context, run.id, null, error);
      if (error instanceof ApiError) error.details = { ...error.details, run_id: run.id, conversation_id: run.conversation_id };
    }
    throw error;
  } finally {
    request.off("aborted", abort);
    response.off("close", disconnect);
  }
}
