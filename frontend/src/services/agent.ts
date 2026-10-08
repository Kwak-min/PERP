import { z } from "zod";

import { ApiError, apiRequest, type ApiSession } from "./api";
import { knowledgeSaveSchema } from "./agent-knowledge";
import { isPgWorkspace } from "./workspace";

const id = z.string().min(1);
const evidenceSchema = z.object({
  type: z.string(), id: id.optional(), title: z.string().optional(), link: z.string().optional(), date: z.string().nullable().optional(),
});
const operationSchema = z.object({
  id, tool: z.string(), version: z.number().int().positive(),
  status: z.enum(["preview", "confirmed", "executed", "cancelled", "failed"]),
  preview: z.object({ title: z.string(), fields: z.array(z.object({ label: z.string(), value: z.string() })), warnings: z.array(z.string()) }),
  requires_confirmation: z.literal(true), requires_approval: z.boolean(), requires_reauth: z.boolean(),
  approval_id: id.nullable(), approval_status: z.string().nullable(),
  can_confirm: z.boolean(), can_execute: z.boolean(), can_cancel: z.boolean(),
  result: z.record(z.string(), z.unknown()).nullable(),
});
const activitySchema = z.object({
  tool_call_id: z.string().nullable(), tool: z.string().nullable(),
  stage: z.enum(["plan", "query", "propose"]), status: z.enum(["completed", "proposed"]), summary: z.string(),
});
const protectedResultSchema = z.object({
  tool_call_id: id, tool: z.string(), result: z.json(), evidence: z.array(z.json()),
  classification: z.string(), truncated: z.boolean(), status: z.literal("protected"),
});
const chatSchema = z.object({
  conversation_id: id,
  answer: z.object({ conclusion: z.string(), evidence: z.array(evidenceSchema), related_data: z.object({ vault_notes_used: z.number() }) }),
  scope: z.object({ vault_mode: z.enum(["off", "on"]), personal_vault_used: z.boolean() }),
  run_id: id, tool_activity: z.array(activitySchema), actions: z.array(operationSchema),
  knowledge_saves: z.array(knowledgeSaveSchema).default([]),
  protected_results: z.array(protectedResultSchema).default([]),
});
const briefSchema = z.object({
  preset_label: z.string(),
  items: z.array(z.object({ kind: z.string(), title: z.string(), priority: z.string(), evidence: evidenceSchema })),
  grounded: z.boolean(),
});
const pendingSchema = z.object({ items: z.array(z.object({
  id, title: z.string().nullable().transform(value => value || "제목 없는 결재"), status: z.string(), version: z.number(),
  requires_reauth: z.boolean(), confirm_self_decision: z.boolean().optional().default(false), blocked: z.boolean(),
})) });
const legacyMemorySchema = z.object({ items: z.array(z.object({ id, content: z.string() })) });
const pgMemorySchema = z.object({ items: z.array(z.object({ id, key: z.string(), value: z.string() })) });

export type AgentChat = z.infer<typeof chatSchema>;
export type AgentBrief = z.infer<typeof briefSchema>;
export type PendingApproval = z.infer<typeof pendingSchema>["items"][number];
export type AgentMemory = Readonly<{ id: string; label: string; content: string }>;
export type AgentOperation = z.infer<typeof operationSchema>;
export type AgentProtectedResult = z.infer<typeof protectedResultSchema>;
export type AgentKnowledgeMode = "personal" | "company";
export type AgentTurn = Readonly<{
  message: string; conversation_id: string | null; key: string; knowledge_mode: AgentKnowledgeMode;
  attachment_ids: readonly string[]; cloud_consent?: Readonly<{ token: string; confirmed: true }>;
}>;
export type AgentOperationRequest = Readonly<{ session: ApiSession; id: string; signal: AbortSignal; knowledgeMode: AgentKnowledgeMode }>;
export type AgentApprover = Readonly<{ id: string; name: string }>;

const root = (session: ApiSession) => isPgWorkspace(session.orgId) ? "/pg/agent" : "/agent";

export async function sendAgentChat(session: ApiSession, turn: AgentTurn, signal: AbortSignal): Promise<AgentChat> {
  const response = chatSchema.parse(await apiRequest(`${root(session)}/chat`, {
    session, signal, method: "POST", headers: { "Idempotency-Key": turn.key },
    body: { message: turn.message, conversation_id: turn.conversation_id, knowledge_mode: turn.knowledge_mode, agent_mode: true,
      attachment_ids: turn.attachment_ids, ...(turn.cloud_consent ? { cloud_consent: turn.cloud_consent } : {}) },
  }));
  if (response.knowledge_saves.some(item => item.scope !== turn.knowledge_mode)) {
    throw new ApiError("응답의 지식 범위가 현재 대화와 다릅니다.", { code: "KNOWLEDGE_SCOPE_MISMATCH", status: 409, requestId: "", details: {} });
  }
  return response;
}

export async function listAgentOperations(session: ApiSession, mode: AgentKnowledgeMode, signal: AbortSignal): Promise<AgentOperation[]> {
  return z.object({ items: z.array(operationSchema) }).parse(await apiRequest(`${root(session)}/operations?knowledge_mode=${mode}`, { session, signal })).items;
}

export async function getAgentOperation(request: AgentOperationRequest): Promise<AgentOperation> {
  return operationSchema.parse(await apiRequest(`${root(request.session)}/operations/${encodeURIComponent(request.id)}?knowledge_mode=${request.knowledgeMode}`, request));
}

export async function getAgentApprovers(request: AgentOperationRequest): Promise<AgentApprover[]> {
  return z.object({ items: z.array(z.object({ id, name: z.string() })) }).parse(
    await apiRequest(`${root(request.session)}/operations/${encodeURIComponent(request.id)}/approvers?knowledge_mode=${request.knowledgeMode}`, request),
  ).items;
}

export async function confirmAgentOperation(request: AgentOperationRequest, body: Readonly<{ expected_version: number; approver_id?: string }>): Promise<AgentOperation> {
  return operationSchema.parse(await apiRequest(`${root(request.session)}/operations/${encodeURIComponent(request.id)}/confirm`, {
    ...request, method: "POST", body: { ...body, knowledge_mode: request.knowledgeMode },
  }));
}

export async function executeAgentOperation(request: AgentOperationRequest, execution: Readonly<{ version: number; key: string; password?: string }>): Promise<AgentOperation> {
  return operationSchema.parse(await apiRequest(`${root(request.session)}/operations/${encodeURIComponent(request.id)}/execute`, {
    ...request, method: "POST", headers: { "Idempotency-Key": execution.key },
    body: { expected_version: execution.version, knowledge_mode: request.knowledgeMode, ...(execution.password ? { reauth_password: execution.password } : {}) },
  }));
}

export async function cancelAgentOperation(request: AgentOperationRequest, version: number): Promise<AgentOperation> {
  return operationSchema.parse(await apiRequest(`${root(request.session)}/operations/${encodeURIComponent(request.id)}/cancel`, {
    ...request, method: "POST", body: { expected_version: version, knowledge_mode: request.knowledgeMode },
  }));
}

export async function getAgentBrief(session: ApiSession, signal: AbortSignal): Promise<AgentBrief> {
  return briefSchema.parse(await apiRequest(`${root(session)}/brief`, { session, signal }));
}

export async function getPendingApprovals(session: ApiSession, signal: AbortSignal): Promise<PendingApproval[]> {
  return pendingSchema.parse(await apiRequest(`${root(session)}/pending-approvals`, { session, signal })).items;
}

export async function decidePendingApproval(session: ApiSession, approval: PendingApproval, decision: "approve" | "reject", comment: string, password: string, confirmSelfDecision: boolean, signal: AbortSignal): Promise<void> {
  const pg = isPgWorkspace(session.orgId);
  const path = pg ? `/pg/approvals/${encodeURIComponent(approval.id)}/actions` : `/approvals/requests/${encodeURIComponent(approval.id)}/actions`;
  const body = pg
    ? { decision, comment, ...(approval.confirm_self_decision ? { confirm_self_decision: confirmSelfDecision } : {}) }
    : { decision, comment, ...(approval.requires_reauth && decision === "approve" ? { reauth_password: password } : {}) };
  await apiRequest(path, { session, signal, method: "POST", body });
}

export async function getAgentMemory(session: ApiSession, signal: AbortSignal): Promise<AgentMemory[]> {
  const payload = await apiRequest(`${root(session)}/memory`, { session, signal });
  if (isPgWorkspace(session.orgId)) {
    return pgMemorySchema.parse(payload).items.map(item => ({ id: item.id, label: item.key, content: item.value }));
  }
  return legacyMemorySchema.parse(payload).items.map(item => ({ id: item.id, label: "기억", content: item.content }));
}

export async function createAgentMemory(session: ApiSession, label: string, content: string, signal: AbortSignal): Promise<void> {
  await apiRequest(`${root(session)}/memory`, { session, signal, method: "POST",
    body: isPgWorkspace(session.orgId) ? { key: label, value: content } : { content },
  });
}

export async function deleteAgentMemory(session: ApiSession, memoryId: string, signal: AbortSignal): Promise<void> {
  await apiRequest(`${root(session)}/memory/${encodeURIComponent(memoryId)}`, { session, signal, method: "DELETE" });
}
