import { z } from 'zod';
import { apiRequest, type ApiSession } from '../../services/api';
import { isPgWorkspace } from '../../services/workspace';

const id = z.string().min(1);
const version = z.number().int().positive().safe();
export const stepSchema = z.object({ approver_id: id, mode: z.enum(['sequential','parallel']), kind: z.string(), ordinal: z.number().optional(), status: z.string().optional(), comment: z.string().nullable().optional(), decided_at: z.string().nullable().optional() });
export const formSchema = z.object({ key: id, name: z.string(), revision: version, fields: z.array(z.object({ key: id, label: z.string(), type: z.enum(['text','textarea','krw']), required: z.boolean() })), route: z.array(stepSchema).optional() });
export const formsSchema = z.object({ items: z.array(formSchema) });
export const receiptSchema = z.object({ file_id: id, filename: z.string(), mime: z.string(), size_bytes: z.number(), checksum_sha256: z.string() });
export const detailSchema = z.object({ id, title: z.string().nullable(), requester_id: id.nullable(), form_key: z.string().nullable(), body: z.record(z.string(), z.unknown()).nullable(), status: z.string(), version,
  form_snapshot: formSchema.nullable(), attachment_snapshot: z.array(receiptSchema), predecessor_id: id.nullable(), steps: z.array(stepSchema).optional(), requires_reauth: z.boolean().optional(), amount: z.number().optional(),
  submitted_at: z.string().nullable().optional(), withdrawn_at: z.string().nullable().optional(), decision_note: z.string().nullable().optional(), target_user_id: id.nullable().optional(), subject_type: z.string().nullable().optional(), subject_id: id.nullable().optional(),
});
export const historySchema = z.object({ items: z.array(z.object({ id: id.nullable(), actor_id: id.nullable(), action: z.string(), status: z.string(), snapshot: z.unknown().nullable(), created_at: z.string(), comment: z.string().nullable().optional(), origin: z.string().optional() })) });
export type ApprovalDetail = z.infer<typeof detailSchema>;
export type ApprovalForm = z.infer<typeof formSchema>;
export type ApprovalStep = z.infer<typeof stepSchema>;
export type Box = 'inbox' | 'sent' | 'completed' | 'drafts';
export type ListRow = { id: string; requester_id: string | null; title: string; status: string; requesterName?: string | null };
const pgListSchema = z.object({ items: z.array(z.object({ __id: id, requester_id: id.nullable(), title: z.string().nullable(), 유형: z.string(), 신청자: z.string().nullable(), status: z.string() })), can_request: z.boolean(), can_decide: z.boolean() });
export const statusLabels: Record<string,string> = { draft: '임시저장', pending: '대기', approved: '승인', rejected: '반려', withdrawn: '철회', held: '보류' };
export const terminal = (status: string) => ['approved','rejected','withdrawn'].includes(status);
export function exactAmount(detail: ApprovalDetail): string | null {
  const snapshotField = detail.form_snapshot?.fields.find(field => field.type === 'krw');
  const value = detail.body?.[snapshotField?.key ?? 'amount_krw'];
  if (typeof value === 'string') return value;
  if (detail.amount !== undefined && Number.isSafeInteger(detail.amount) && detail.amount >= 0) {
    const minor = BigInt(detail.amount); return `${minor / 100n}.${String(minor % 100n).padStart(2,'0')}`;
  }
  return null;
}

// DTO와 CAS가 다른 두 저장소를 명시적으로 선택한다. 실패 시 다른 저장소로 재시도하지 않는다.
export function approvalAdapter(session: ApiSession) {
  const pg = isPgWorkspace(session.orgId);
  const root = pg ? '/pg/approvals' : '/approvals';
  const requests = pg ? root : root + '/requests';
  const detailPath = (value: string) => `${requests}/${encodeURIComponent(value)}`;
  return {
    pg, root, detailPath,
    async identity(signal: AbortSignal) {
      const value = await apiRequest(pg ? '/pg/auth/me' : '/auth/me', { session, signal });
      return pg ? z.object({ user: z.object({ id }) }).parse(value).user.id : z.object({ id }).parse(value).id;
    },
    async list(box: Box, userId: string, page: number, signal: AbortSignal): Promise<{ items: ListRow[]; hasMore: boolean }> {
      if (pg) {
        const data = pgListSchema.parse(await apiRequest(root, { session, signal }));
        const rows = data.items.filter(row => box === 'sent' ? row.requester_id === userId
          : box === 'drafts' ? row.status === 'draft' && row.requester_id === userId
            : box === 'completed' ? terminal(row.status) : data.can_decide && row.status === 'pending');
        return { items: rows.slice(page * 25, (page + 1) * 25).map(row => ({ id: row.__id, requester_id: row.requester_id, title: row.title ?? row.유형, status: row.status, requesterName: row.신청자 })), hasMore: rows.length > (page + 1) * 25 };
      }
      const data = z.object({ items: z.array(detailSchema), has_more: z.boolean() }).parse(await apiRequest(`${requests}?box=${box}&limit=25&offset=${page * 25}`, { session, signal }));
      return { items: data.items.map(row => ({ ...row, title: row.title ?? row.form_key ?? '기존 요청' })), hasMore: data.has_more };
    },
    async forms(signal: AbortSignal) { return formsSchema.parse(await apiRequest(root + '/forms', { session, signal })).items; },
    async candidates(signal: AbortSignal) { return z.object({ items: z.array(z.object({ id, name: z.string() })) }).parse(await apiRequest(root + '/approver-candidates', { session, signal })).items; },
    async detail(value: string, signal: AbortSignal) { return detailSchema.parse(await apiRequest(detailPath(value), { session, signal })); },
    async history(value: string, signal: AbortSignal) { return historySchema.parse(await apiRequest(detailPath(value) + '/history', { session, signal })).items; },
    async mutate(path: string, method: 'POST' | 'PATCH', body: unknown, signal: AbortSignal) {
      return detailSchema.parse(await apiRequest(path, { session, method, body, signal }));
    },
  };
}
