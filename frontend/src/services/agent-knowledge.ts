import { z } from 'zod';
import { apiRequest, type ApiSession } from './api';
import { isPgWorkspace } from './workspace';

const root = (session: ApiSession) => isPgWorkspace(session.orgId) ? '/pg/agent' : '/agent';

export type KnowledgeMode = 'personal' | 'company';
const modeSchema = z.enum(['personal', 'company']);
const attachmentSchema = z.object({
  id: z.string().uuid(), filename: z.string(), mime: z.string(), size: z.number(),
  knowledge_mode: modeSchema, classification: z.string(), text_length: z.number(),
  content_hash: z.string(), download_url: z.string(),
});
export type AgentAttachment = z.infer<typeof attachmentSchema>;
export const knowledgeSaveSchema = z.object({
  status: z.enum(['saved', 'skipped', 'failed']), scope: modeSchema,
  id: z.string().optional(), link: z.string().optional(), title: z.string().optional(),
  code: z.string().optional(), ai_generated: z.literal(true), review_status: z.literal('unreviewed'),
});
export type KnowledgeSave = z.infer<typeof knowledgeSaveSchema>;
const noteSchema = z.object({id:z.string(),title:z.string(),content:z.string(),classification:z.string(),scope:modeSchema,
  link:z.string(),ai_generated:z.literal(true),review_status:z.literal('unreviewed'),provenance:z.array(z.record(z.string(),z.unknown()))});
export type AgentKnowledgeNote = z.infer<typeof noteSchema>;
export async function listAgentKnowledgeNotes(session: ApiSession, mode: KnowledgeMode, signal?: AbortSignal): Promise<AgentKnowledgeNote[]> {
  return z.object({items:z.array(noteSchema)}).parse(await apiRequest(`${root(session)}/knowledge/notes?knowledge_mode=${mode}`, {session,...(signal ? {signal} : {})})).items;
}
export async function getAgentKnowledgeNote(session: ApiSession, mode: KnowledgeMode, id: string, signal?: AbortSignal): Promise<AgentKnowledgeNote> {
  return noteSchema.parse(await apiRequest(`${root(session)}/knowledge/notes/${encodeURIComponent(id)}?knowledge_mode=${mode}`, {session,...(signal ? {signal} : {})}));
}
const previewSchema = z.object({
  token: z.string().uuid(), expires_at: z.string(), scope_hash: z.string(), provider: z.string(),
  model: z.string(), knowledge_mode: z.literal('personal'),
  sources: z.array(z.object({id:z.string(), kind:z.string(), title:z.string(), version:z.string(), content_hash:z.string()})),
});
export type KnowledgeConsentPreview = z.infer<typeof previewSchema>;
export type KnowledgeConsentInput = Readonly<{
  knowledge_mode: KnowledgeMode; message: string; attachment_ids?: readonly string[];
  conversation_id?: string | null; classification?: string;
}>;

export async function uploadAgentAttachment(session: ApiSession, mode: KnowledgeMode, file: File, signal?: AbortSignal): Promise<AgentAttachment> {
  if (file.size === 0 || file.size > 1_000_000) throw new Error('Document must contain 1 to 1,000,000 bytes.');
  signal?.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const ext = file.name.split('.').at(-1)?.toLowerCase();
  const mime = file.type || ({txt:'text/plain',md:'text/markdown',pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'} as Record<string,string>)[ext ?? ''] || 'application/octet-stream';
  return attachmentSchema.parse(await apiRequest(`${root(session)}/attachments`, {session, ...(signal ? {signal} : {}), method:'POST', body:{
    knowledge_mode:mode, filename:file.name, mime, content_base64:btoa(binary),
  }}));
}
export async function deleteAgentAttachment(session: ApiSession, mode: KnowledgeMode, id: string, signal?: AbortSignal): Promise<void> {
  await apiRequest(`${root(session)}/attachments/${encodeURIComponent(id)}?knowledge_mode=${mode}`, {session, ...(signal ? {signal} : {}), method:'DELETE'});
}
export async function previewAgentKnowledgeConsent(session: ApiSession, input: KnowledgeConsentInput, signal?: AbortSignal): Promise<KnowledgeConsentPreview> {
  return previewSchema.parse(await apiRequest(`${root(session)}/knowledge/consent-preview`, {session, ...(signal ? {signal} : {}), method:'POST', body:input}));
}
export async function downloadAgentAttachment(session: ApiSession, mode: KnowledgeMode, id: string, signal?: AbortSignal): Promise<Blob> {
  // Downloads use the same authenticated JSON transport: no public URL or bearer in query strings.
  const payload = z.object({filename:z.string(),mime:z.string(),content_base64:z.string()}).parse(
    await apiRequest(`${root(session)}/attachments/${encodeURIComponent(id)}/download?knowledge_mode=${mode}&encoding=base64`, {session, ...(signal ? {signal} : {})}));
  return new Blob([Uint8Array.from(atob(payload.content_base64), c => c.charCodeAt(0))], {type:payload.mime});
}
