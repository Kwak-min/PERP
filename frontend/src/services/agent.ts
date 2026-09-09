import { z } from "zod";

import { apiRequest, type ApiSession } from "./api";
import { isPgWorkspace } from "./workspace";

const id = z.string().min(1);
const evidenceSchema = z.object({
  type: z.string(), id: id.optional(), title: z.string().optional(), link: z.string().optional(), date: z.string().nullable().optional(),
});
const chatSchema = z.object({
  conversation_id: id,
  answer: z.object({ conclusion: z.string(), evidence: z.array(evidenceSchema), related_data: z.object({ vault_notes_used: z.number() }) }),
  scope: z.object({ vault_mode: z.literal("off"), personal_vault_used: z.literal(false) }),
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

const root = (session: ApiSession) => isPgWorkspace(session.orgId) ? "/pg/agent" : "/agent";

export async function sendAgentChat(session: ApiSession, message: string, conversationId: string | null, signal: AbortSignal): Promise<AgentChat> {
  return chatSchema.parse(await apiRequest(`${root(session)}/chat`, {
    session, signal, method: "POST", body: { message, conversation_id: conversationId, vault_mode: "off" },
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
