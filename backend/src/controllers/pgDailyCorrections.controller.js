import { z } from 'zod';
import { pgQuery, pgTransaction } from '../config/pg.js';
import { pgIdentity } from '../middleware/pgAccess.js';
import { correctionDate, correctionVersion, assertCorrectionWindow, assertCorrectionVersion } from '../services/daily-corrections.service.js';
import { ApiError } from '../utils/errors.js';
import { assertPgProjectAssignee, notifyPgTaskAssignment } from '../services/project-assignment.service.js';

const idSchema = z.string().regex(/^[1-9]\d*$/);
const projectInput = z.object({ version: correctionVersion, name: z.string().trim().min(1).max(200).optional(),
  status: z.literal('done').optional(),
  description: z.string().nullable().optional(), starts_on: correctionDate.optional(), ends_on: correctionDate.optional() }).strict();
const taskInput = z.object({ version: correctionVersion, title: z.string().trim().min(1).max(300).optional(),
  assignee_id: idSchema.nullable().optional(), due_on: correctionDate.optional(),
  status: z.enum(['todo', 'in_progress', 'done', 'blocked', 'cancelled']).optional() }).strict();
const eventInput = z.object({ version: correctionVersion, title: z.string().trim().min(1).max(200).optional(),
  starts_at: z.string().datetime({ offset: true }).optional(), ends_at: z.string().datetime({ offset: true }).optional(),
  location: z.string().nullable().optional() }).strict();
const assetInput = z.object({ version: correctionVersion, assignee_id: idSchema.nullable().optional(),
  name: z.string().trim().min(1).max(200).optional(), category: z.string().nullable().optional(), location: z.string().nullable().optional(),
  status: z.enum(['in_use', 'stored', 'repair', 'disposed', 'lost']).optional() }).strict();
const definitions = {
  projects: { table: 'project.projects', schema: projectInput, dates: ['starts_on', 'ends_on'] },
  tasks: { table: 'project.tasks', schema: taskInput, dates: ['due_on'] },
  calendar: { table: 'calendar.events', schema: eventInput, dates: [] },
  assets: { table: 'asset.assets', schema: assetInput, dates: [] },
};

// DATE를 JS Date/UTC로 왕복시키면 한국 시간대에서 하루가 줄어든다. SQL 경계에서 날짜 문자열로 유지한다.
const fields = definition => ['t.*', ...definition.dates.map(column => `to_char(t.${column}, 'YYYY-MM-DD') AS ${column}`)].join(', ');

async function correct(req, resource, cancel = false) {
  const { companyId, userId } = pgIdentity(req);
  const id = idSchema.parse(req.params.id), definition = definitions[resource];
  const { version, ...changes } = (cancel ? z.object({ version: correctionVersion }).strict() : definition.schema).parse(req.body);
  if (cancel) changes.cancelled_at = new Date().toISOString();
  if (!Object.keys(changes).length) throw new ApiError('VALIDATION_ERROR', '변경할 내용을 입력하세요');
  return pgTransaction(async client => {
    const scope = resource === 'tasks' ? 't.project_id IN (SELECT id FROM project.projects WHERE company_id = $2)' : 't.company_id = $2';
    const before = (await client.query(`SELECT ${fields(definition)} FROM ${definition.table} t WHERE t.id = $1 AND ${scope} FOR UPDATE`, [id, companyId])).rows[0];
    if (!before) throw new ApiError('NOT_FOUND', '대상을 찾을 수 없습니다');
    assertCorrectionVersion(before, version);
    if (resource === 'calendar' && before.cancelled_at) throw new ApiError('CONFLICT', '취소한 일정은 변경할 수 없습니다');
    if (resource === 'assets' && before.status === 'disposed') throw new ApiError('CONFLICT', '폐기된 자산은 변경할 수 없습니다');
    if (resource === 'tasks' && changes.assignee_id != null) {
      await assertPgProjectAssignee(client, { companyId, projectId: before.project_id, userId: changes.assignee_id });
    } else if (changes.assignee_id != null) {
      const membership = await client.query(`SELECT m.user_id FROM org.company_memberships m JOIN auth.users u ON u.id = m.user_id
        WHERE m.company_id = $1 AND m.user_id = $2 AND m.status = 'active'
          AND u.account_status = 'active' AND u.approval_status = 'approved' FOR SHARE OF m, u`, [companyId, changes.assignee_id]);
      if (!membership.rows.length) throw new ApiError('PERMISSION_DENIED', '현재 회사의 활성 구성원만 담당자로 지정할 수 있습니다');
    }
    const merged = { ...before, ...changes };
    if (resource === 'projects') assertCorrectionWindow(merged.starts_on, merged.ends_on);
    if (resource === 'calendar' && Date.parse(merged.ends_at) <= Date.parse(merged.starts_at)) throw new ApiError('VALIDATION_ERROR', '종료는 시작보다 늦어야 합니다');
    const entries = Object.entries(changes);
    if (resource === 'tasks' && entries.length === 1 && Object.hasOwn(changes, 'assignee_id') && String(changes.assignee_id) === String(before.assignee_id)) {
      return { ...before, id: String(before.id), assignee_id: before.assignee_id == null ? null : String(before.assignee_id) };
    }
    const after = (await client.query(`UPDATE ${definition.table} t SET ${entries.map(([key], index) => `${key} = $${index + 4}`).join(', ')},
      version = t.version + 1 WHERE t.id = $1 AND ${scope} AND t.version = $3 RETURNING ${fields(definition)}`, [id, companyId, version, ...entries.map(([, value]) => value)])).rows[0];
    if (!after) throw new ApiError('VERSION_CONFLICT', '다른 사용자가 변경했습니다');
    const action = cancel ? 'cancelled' : resource === 'assets' ? 'custody.updated' : 'updated';
    await client.query(`INSERT INTO org.daily_correction_events(company_id, actor_id, resource_type, resource_id, action, before_data, after_data)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`, [companyId, userId, resource, id, action, JSON.stringify(before), JSON.stringify(after)]);
    if (resource === 'tasks' && String(after.assignee_id) !== String(before.assignee_id)) await notifyPgTaskAssignment(client, { companyId, userId }, after);
    if (resource === 'assets') await client.query(`INSERT INTO asset.history(asset_id, event_type, actor_id, note) VALUES ($1,'custody.updated',$2,$3)`,
      [id, userId, JSON.stringify({ before: { assignee_id: before.assignee_id, status: before.status }, after: { assignee_id: after.assignee_id, status: after.status } })]);
    return { ...after, id: String(after.id), ...(after.assignee_id != null ? { assignee_id: String(after.assignee_id) } : {}), ...(cancel ? { cancelled: true } : {}) };
  });
}
// 과거 generic 경로도 동일 계약을 통과한다. 금융 리소스는 소유 핸들러에 그대로 위임한다.
export function dailyRecordRoute(fallback) {
  return async (req, res) => {
    const resource = req.params.resource;
    if (!Object.hasOwn(definitions, resource)) return fallback(req, res);
    if (req.method === 'PATCH') return res.json(await correct(req, resource));
    if (req.method === 'DELETE') {
      if (resource === 'calendar') return res.json(await correct(req, resource, true));
      throw new ApiError('CONFLICT', '업무 기록은 삭제할 수 없습니다. 상태 변경으로 이력을 보관하세요.');
    }
    const { companyId } = pgIdentity(req), id = idSchema.parse(req.params.id);
    const scope = resource === 'tasks' ? 't.project_id IN (SELECT id FROM project.projects WHERE company_id = $2)' : 't.company_id = $2';
    const row = (await pgQuery(`SELECT ${fields(definitions[resource])} FROM ${definitions[resource].table} t WHERE t.id = $1 AND ${scope}`, [id, companyId])).rows[0];
    if (!row) throw new ApiError('NOT_FOUND', '대상을 찾을 수 없습니다');
    return res.json(row);
  };
}
export async function patchProject(req, res) { res.json(await correct(req, 'projects')); }
export async function patchTask(req, res) { res.json(await correct(req, 'tasks')); }
export async function patchCalendar(req, res) { res.json(await correct(req, 'calendar')); }
export async function cancelCalendar(req, res) { res.json(await correct(req, 'calendar', true)); }
export async function patchAssetCustody(req, res) { res.json(await correct(req, 'assets')); }
export async function getAssetCustody(req, res) {
  const { companyId } = pgIdentity(req), id = idSchema.parse(req.params.id);
  const row = (await pgQuery('SELECT * FROM asset.assets WHERE id = $1 AND company_id = $2', [id, companyId])).rows[0];
  if (!row) throw new ApiError('NOT_FOUND', '자산을 찾을 수 없습니다');
  const history = (await pgQuery('SELECT event_type, actor_id, note, created_at FROM asset.history WHERE asset_id = $1 ORDER BY id DESC', [id])).rows;
  res.json({ ...row, id: String(row.id), assignee_id: row.assignee_id == null ? null : String(row.assignee_id), history });
}
