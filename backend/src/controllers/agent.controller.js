import { z } from "zod";

import { db } from "../config/db.js";
import { PRESETS, TOOLS, presetFor } from "../config/agent-tools.js";
import { resolvePrincipal } from "../middleware/auth.js";
import { getScoped, insert, listScoped, newId, nowIso, softDelete, update } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { createApproval } from "../services/approval.service.js";
import { buildPreview, execute, rollback } from "../services/agent-executor.service.js";
import * as providers from "../services/ai-provider.service.js";
import { completeForUser, keyMetadata } from "../services/ai-key.service.js";
import * as rag from "../services/rag.service.js";
import { verifyPassword } from "../utils/crypto.js";
import { ApiError, notFound } from "../utils/errors.js";

const HIGH_RISK_MEMORY_PATTERNS = [
  /비밀번호/i,
  /password/i,
  /api[_ -]?key/i,
  /secret/i,
  /주민등록번호/,
  /계좌\s*비밀/,
  /\b\d{6}-\d{7}\b/,
];

export function blockedMemoryReason(content) {
  for (const pattern of HIGH_RISK_MEMORY_PATTERNS) {
    if (pattern.test(content)) {
      return "high-risk credential-like content cannot be stored in agent memory";
    }
  }
  return null;
}

const chatSchema = z.object({
  message: z.string().min(1),
  conversation_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  data_class: z.enum(["public", "internal", "personal", "sensitive", "confidential"]).default("internal"),
});

const memorySchema = z.object({
  content: z.string().min(1).max(2000),
  source: z.string().default("user"),
  sensitivity: z.enum(["public", "internal", "personal", "sensitive", "confidential"]).default("internal"),
  usage_scope: z.string().default("personal"),
  expires_at: z.string().nullable().optional(),
});

const actionSchema = z.object({
  tool: z.string(),
  input: z.record(z.any()).default({}),
  conversation_id: z.string().nullable().optional(),
  approver_id: z.string().nullable().optional(),
});

const executeSchema = z.object({
  reauth_password: z.string().nullable().optional(),
});

const profileSchema = z.object({
  preset: z.string().nullable().optional(),
  model_policy: z.enum(["auto", "local", "external"]).nullable().optional(),
  preferences: z.record(z.any()).default({}),
});

export async function chat(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const payload = chatSchema.parse(req.body);

  let conversation = null;
  if (payload.conversation_id) {
    conversation = getScoped("ai_conversation", principal, payload.conversation_id, "conversation");
    if (conversation.user_id !== principal.userId) throw notFound("conversation");
  }
  if (!conversation) {
    conversation = insert("ai_conversation", {
      tenant_id: principal.tenantId,
      org_id: principal.orgId,
      user_id: principal.userId,
      project_id: payload.project_id ?? null,
      title: payload.message.slice(0, 60),
      created_by: principal.userId,
    });
  }

  const citations = [
    ...rag.searchChunks(principal, payload.message),
    ...rag.searchVaultNotes(principal, payload.message),
  ];
  const memories = rag.recallMemories(principal);
  const context = rag.buildContext(citations, memories);
  const dataClass = rag.effectiveDataClass(payload.data_class, citations, memories);
  const result = await completeForUser(principal, {
    dataClass,
    system: `${rag.SYSTEM_POLICY}\n\n${context}`,
    user: payload.message,
  });

  const answer = {
    conclusion: result.text ? result.text.slice(0, 2000) : "근거가 되는 데이터를 찾지 못했습니다.",
    evidence: citations,
    related_data: {
      memory_used: memories.length,
      citation_count: citations.length,
      vault_notes_used: citations.filter((c) => c.type === "vault_note").length,
    },
    uncertainty: citations.length === 0 ? "근거 문서 없음 - 답변 신뢰도가 낮습니다" : "근거 문서 기반",
    next_actions: ["관련 문서를 열어 확인하기", "필요하면 업무 생성 초안을 요청하기"],
    executable: false,
    required_approval: null,
    grounded: citations.length > 0,
  };

  insert("ai_message", {
    tenant_id: principal.tenantId,
    conversation_id: conversation.id,
    role: "user",
    content: payload.message,
    created_by: principal.userId,
  });
  insert("ai_message", {
    tenant_id: principal.tenantId,
    conversation_id: conversation.id,
    role: "assistant",
    content: answer.conclusion,
    citations: JSON.stringify(citations),
    answer_json: JSON.stringify(answer),
    created_by: principal.userId,
  });
  update("ai_conversation", conversation.id, {
    cost_micro: conversation.cost_micro + result.cost_micro,
  });

  db()
    .prepare(
      `INSERT INTO ai_request_log
       (id, request_id, user_id, tenant_id, model, provider, prompt_tokens, completion_tokens,
        cost_micro, latency_ms, tool_calls, citations, approval_id, result, error, data_class,
        fallback_from, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, NULL, ?, ?, ?, NULL, ?)`,
    )
    .run(
      newId(),
      req.requestId ?? "",
      principal.userId,
      principal.tenantId,
      result.model,
      result.provider,
      result.prompt_tokens,
      result.completion_tokens,
      result.cost_micro,
      result.latency_ms,
      JSON.stringify(citations.map((c) => c.id)),
      result.error ? "error" : "ok",
      result.error ?? null,
      dataClass,
      nowIso(),
    );

  res.json({
    conversation_id: conversation.id,
    answer,
    model: result.model,
    provider: result.provider,
    latency_ms: result.latency_ms,
    ai_generated: true,
    generated_at: nowIso(),
  });
}

export function listConversations(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const rows = listScoped(
    "ai_conversation",
    principal,
    [{ sql: "user_id = ?", params: [principal.userId] }],
    { limit: Number(req.query.limit ?? 50) },
  );
  res.json({ items: rows.map((c) => ({ id: c.id, title: c.title, cost_micro: c.cost_micro })) });
}

export function brief(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const today = nowIso().slice(0, 10);

  const tasks = listScoped(
    "task",
    principal,
    [
      { sql: "assignee_id = ?", params: [principal.userId] },
      { sql: "status != ?", params: ["done"] },
    ],
    { limit: 200 },
  );
  const pendingSteps = listScoped(
    "approval_step",
    principal,
    [
      { sql: "approver_id = ?", params: [principal.userId] },
      { sql: "status = ?", params: ["pending"] },
    ],
    { limit: 200 },
  );

  const preset = presetFor(principal.roles);
  const items = [];
  for (const task of tasks.filter((t) => t.due_at && t.due_at.slice(0, 10) < today).slice(0, 5)) {
    items.push({
      kind: "overdue_task",
      title: task.title,
      evidence: { type: "task", id: task.id, link: `/tasks/${task.id}`, date: task.due_at },
      priority: "high",
    });
  }
  for (const task of tasks.filter((t) => t.due_at && t.due_at.slice(0, 10) === today).slice(0, 5)) {
    items.push({
      kind: "today_task",
      title: task.title,
      evidence: { type: "task", id: task.id, link: `/tasks/${task.id}`, date: task.due_at },
      priority: "normal",
    });
  }
  if (pendingSteps.length > 0) {
    items.push({
      kind: "approval",
      title: `승인 대기 ${pendingSteps.length}건`,
      evidence: { type: "approval", link: "/approvals" },
      priority: "high",
    });
  }

  res.json({
    preset,
    preset_label: PRESETS[preset].label,
    sections: PRESETS[preset].brief,
    items,
    ai_generated: true,
    generated_at: nowIso(),
    grounded: true,
  });
}

const memoryView = (m) => ({
  id: m.id,
  content: m.content,
  source: m.source,
  sensitivity: m.sensitivity,
  usage_scope: m.usage_scope,
  expires_at: m.expires_at,
  created_at: m.created_at,
});

export function createMemory(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const payload = memorySchema.parse(req.body);
  const reason = blockedMemoryReason(payload.content);
  if (reason) throw new ApiError("VALIDATION_ERROR", reason);

  const memory = insert("agent_memory", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    owner_id: principal.userId,
    content: payload.content,
    source: payload.source,
    sensitivity: payload.sensitivity,
    usage_scope: payload.usage_scope,
    expires_at: payload.expires_at ?? null,
    created_by: principal.userId,
  });
  res.status(201).json(memoryView(memory));
}

export function listMemory(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  res.json({ items: rag.recallMemories(principal, 500).map(memoryView) });
}

export function updateMemory(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const payload = memorySchema.parse(req.body);
  const memory = getScoped("agent_memory", principal, req.params.memoryId, "memory");
  if (memory.owner_id !== principal.userId) throw notFound("memory");
  const reason = blockedMemoryReason(payload.content);
  if (reason) throw new ApiError("VALIDATION_ERROR", reason);

  const updated = update(
    "agent_memory",
    memory.id,
    {
      content: payload.content,
      sensitivity: payload.sensitivity,
      usage_scope: payload.usage_scope,
      expires_at: payload.expires_at ?? null,
      version: memory.version + 1,
    },
    principal.userId,
  );
  res.json({ id: updated.id, content: updated.content });
}

export function deleteMemory(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const memory = getScoped("agent_memory", principal, req.params.memoryId, "memory");
  if (memory.owner_id !== principal.userId) throw notFound("memory");
  softDelete("agent_memory", memory.id, principal.userId);
  res.json({ id: memory.id, deleted: true });
}

export function clearMemory(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const rows = rag.recallMemories(principal, 1000);
  for (const memory of rows) softDelete("agent_memory", memory.id, principal.userId);
  res.json({ cleared: rows.length });
}

export function listTools(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const preset = presetFor(principal.roles);
  const allowed = new Set(PRESETS[preset].tools);
  res.json({
    preset,
    items: Object.values(TOOLS).map((spec) => ({
      name: spec.name,
      stage: spec.stage,
      resource: spec.resource,
      permission: spec.permission,
      requires_approval: spec.requires_approval,
      requires_reauth: spec.requires_reauth,
      rollback: spec.rollback,
      granted: allowed.has(spec.name) && principal.has(spec.permission),
    })),
  });
}

export function previewAction(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const payload = actionSchema.parse(req.body);

  const spec = TOOLS[payload.tool];
  if (!spec) {
    throw new ApiError("PERMISSION_DENIED", `tool is not in the allowlist: ${payload.tool}`);
  }
  principal.require(spec.permission);

  const preview = buildPreview(principal, spec.name, payload.input);
  const action = insert("agent_action", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    user_id: principal.userId,
    conversation_id: payload.conversation_id ?? null,
    tool: spec.name,
    stage: spec.stage,
    input_json: JSON.stringify(payload.input),
    preview_json: JSON.stringify(preview),
    impact: preview.impact ?? "",
    requires_approval: spec.requires_approval ? 1 : 0,
    requires_reauth: spec.requires_reauth ? 1 : 0,
    status: "preview",
    created_by: principal.userId,
  });

  let approvalId = null;
  let status = "preview";
  if (spec.requires_approval) {
    if (!payload.approver_id) {
      throw new ApiError("VALIDATION_ERROR", "approver_id is required for this high-risk tool");
    }
    const approval = createApproval(principal, {
      title: `Agent 실행 승인: ${spec.name}`,
      steps: [{ approver_id: payload.approver_id }],
      formKey: "agent_action",
      subjectType: "agent_action",
      subjectId: action.id,
      payload: payload.input,
    });
    approvalId = approval.id;
    status = "awaiting_approval";
    update("agent_action", action.id, { approval_id: approval.id, status }, principal.userId);
  }

  audit.record({
    tenantId: principal.tenantId,
    action: "agent.action.previewed",
    resourceType: "agent_action",
    resourceId: action.id,
    actorId: principal.userId,
    after: { tool: spec.name, requires_approval: spec.requires_approval },
    requestId: req.requestId,
    aiGenerated: true,
    approvalId,
  });

  res.status(201).json({
    id: action.id,
    tool: spec.name,
    stage: spec.stage,
    status,
    preview,
    requires_approval: spec.requires_approval,
    requires_reauth: spec.requires_reauth,
    approval_id: approvalId,
    rollback_supported: Boolean(spec.rollback),
  });
}

export function executeAction(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const payload = executeSchema.parse(req.body ?? {});
  const idempotencyKey = req.get("idempotency-key") ?? null;

  const action = getScoped("agent_action", principal, req.params.actionId, "agent action");
  if (action.user_id !== principal.userId) throw notFound("agent action");

  const spec = TOOLS[action.tool];
  if (!spec || spec.stage !== "execute") {
    throw new ApiError("PERMISSION_DENIED", `tool is not executable: ${action.tool}`);
  }
  principal.require(spec.permission);

  if (action.status === "executed") throw new ApiError("CONFLICT", "action already executed");
  if (action.status === "rolled_back") throw new ApiError("CONFLICT", "action was rolled back");

  if (spec.requires_approval) {
    const approval = action.approval_id
      ? db().prepare("SELECT * FROM approval WHERE id = ?").get(action.approval_id)
      : null;
    if (!approval || approval.status !== "approved") {
      throw new ApiError("APPROVAL_REQUIRED", "high-risk agent action requires an approved request");
    }
  }
  if (spec.requires_reauth) {
    const user = db().prepare("SELECT * FROM app_user WHERE id = ?").get(principal.userId);
    if (!payload.reauth_password || !verifyPassword(payload.reauth_password, user.password_hash)) {
      throw new ApiError("PERMISSION_DENIED", "high-risk agent action requires re-authentication");
    }
  }
  if (idempotencyKey && action.idempotency_key === idempotencyKey) {
    throw new ApiError("IDEMPOTENCY_CONFLICT", "this action was already executed with the same key");
  }

  const [result, rollbackRef] = execute(principal, action, req.requestId);
  update(
    "agent_action",
    action.id,
    {
      status: "executed",
      result_json: JSON.stringify(result),
      rollback_ref: JSON.stringify(rollbackRef),
      executed_at: nowIso(),
      idempotency_key: idempotencyKey,
    },
    principal.userId,
  );

  audit.record({
    tenantId: principal.tenantId,
    action: "agent.action.executed",
    resourceType: "agent_action",
    resourceId: action.id,
    actorId: principal.userId,
    before: JSON.parse(action.preview_json || "{}").before ?? null,
    after: result,
    requestId: req.requestId,
    aiGenerated: true,
    approvalId: action.approval_id,
  });

  res.json({
    id: action.id,
    tool: action.tool,
    status: "executed",
    result,
    rollback_ref: rollbackRef,
    executed_at: nowIso(),
  });
}

export function rollbackAction(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const action = getScoped("agent_action", principal, req.params.actionId, "agent action");
  if (action.user_id !== principal.userId) throw notFound("agent action");
  if (action.status !== "executed") {
    throw new ApiError("CONFLICT", "only executed actions can be rolled back");
  }
  res.json(rollback(principal, action, req.requestId));
}

export function listActions(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const rows = listScoped(
    "agent_action",
    principal,
    [{ sql: "user_id = ?", params: [principal.userId] }],
    { limit: Number(req.query.limit ?? 50) },
  );
  res.json({
    items: rows.map((a) => ({
      id: a.id,
      tool: a.tool,
      status: a.status,
      requires_approval: Boolean(a.requires_approval),
      approval_id: a.approval_id,
      executed_at: a.executed_at,
    })),
  });
}

export function getProfile(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const profile = listScoped(
    "agent_profile",
    principal,
    [{ sql: "user_id = ?", params: [principal.userId] }],
    { limit: 1 },
  )[0];
  const preset = profile?.preset ?? presetFor(principal.roles);
  res.json({
    preset,
    label: (PRESETS[preset] ?? PRESETS.member).label,
    tools: (PRESETS[preset] ?? PRESETS.member).tools,
    model_policy: profile?.model_policy ?? "auto",
    preferences: profile ? JSON.parse(profile.preferences) : {},
    note: "조직 정책이 개인 설정보다 우선합니다",
  });
}

export function putProfile(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const payload = profileSchema.parse(req.body);

  let profile = listScoped(
    "agent_profile",
    principal,
    [{ sql: "user_id = ?", params: [principal.userId] }],
    { limit: 1 },
  )[0];
  if (!profile) {
    profile = insert("agent_profile", {
      tenant_id: principal.tenantId,
      org_id: principal.orgId,
      user_id: principal.userId,
      created_by: principal.userId,
    });
  }

  const patch = { preferences: JSON.stringify(payload.preferences) };
  if (payload.preset) {
    if (!(payload.preset in PRESETS)) {
      throw new ApiError("VALIDATION_ERROR", `unknown preset: ${payload.preset}`);
    }
    patch.preset = payload.preset;
  }
  if (payload.model_policy) patch.model_policy = payload.model_policy;

  const updated = update("agent_profile", profile.id, patch, principal.userId);
  res.json({ preset: updated.preset, model_policy: updated.model_policy });
}

export function listProviders(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  res.json({
    items: Object.entries(providers.REGISTRY).map(([name, provider]) => ({
      name,
      local: provider.local,
      available: name === "openrouter" ? keyMetadata(principal).configured : provider.available(),
    })),
    routing_rules: [
      "데이터 등급 sensitive/confidential 은 외부 LLM 전송 차단(로컬 전용)",
      "OpenRouter 요청 실패는 오류로 반환하며 로컬 성공으로 대체하지 않음",
      "모든 요청은 model/provider/token/cost/latency/citations/approval 기록",
    ],
  });
}

export function usage(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("agent.chat");
  const rows = db()
    .prepare("SELECT * FROM ai_request_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(principal.tenantId, Number(req.query.limit ?? 100));
  res.json({
    items: rows.map((r) => ({
      request_id: r.request_id,
      model: r.model,
      provider: r.provider,
      prompt_tokens: r.prompt_tokens,
      completion_tokens: r.completion_tokens,
      cost_micro: r.cost_micro,
      latency_ms: r.latency_ms,
      result: r.result,
      data_class: r.data_class,
      created_at: r.created_at,
    })),
    total_cost_micro: rows.reduce((s, r) => s + r.cost_micro, 0),
    avg_latency_ms: rows.length
      ? Math.round((10 * rows.reduce((s, r) => s + r.latency_ms, 0)) / rows.length) / 10
      : 0,
  });
}
