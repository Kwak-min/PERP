import { listPgDocuments } from './pg-documents.service.js';
import { z } from 'zod';
import { db } from '../config/db.js';
import { pgTransaction } from '../config/pg.js';
import { TOOLS, PRESETS, presetFor } from '../config/agent-tools.js';
import { CORE_MODULES } from '../config/modules.js';
import { effectivePgPermissions } from '../config/menu-permissions.js';
import { enabledFeatureSet } from '../config/features.js';
import { resolvePrincipal } from '../middleware/auth.js';
import { enabledSet } from '../middleware/modules.js';
import { pgIdentity } from '../middleware/pgAccess.js';
import { listScoped, getScoped } from '../models/base.js';
import { canReadDocument } from './rag.service.js';
import { legacyProjectMoney, pgProjectMoney } from './project-money.service.js';
import { ApiError, notFound } from '../utils/errors.js';

const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const version = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const date = { ...text(10), format: 'date' };
const instant = { ...text(40), format: 'date-time' };
const enumeration = values => ({ type: 'string', enum: values });
const searchNames = ['search.documents', 'search.tasks', 'search.events', 'search.transactions', 'search.members', 'search.projects'];
const supported = new Set([...searchNames, 'get.brief', 'get.project_money', 'create.task', 'update.task_status', 'create.event', 'create.document', 'confirm.transaction']);
const targets = {
  document: ['documents', 'documents'], task: ['projects', 'tasks'], event: ['calendar', 'calendar'],
  transaction: ['finance', 'finance'], membership: ['members', 'members'], project: ['projects', 'projects'],
  dashboard: ['agent', 'agent'],
};

export function inputSchema(source, name) {
  const id = source === 'pg' ? { ...text(19), pattern: '^[1-9][0-9]*$' } : text(100);
  const project = source === 'pg' ? id : nullable(id);
  const statuses = source === 'pg' ? ['todo', 'in_progress', 'done', 'blocked', 'cancelled'] : ['todo', 'in_progress', 'review', 'done', 'blocked', 'cancelled'];
  if (searchNames.includes(name)) return object({
    query: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
    ...(['search.tasks', 'search.events', 'search.documents', 'search.transactions'].includes(name) && !(source === 'pg' && name === 'search.events') ? { project_id: id } : {}),
    ...(name === 'search.tasks' ? { status: enumeration(statuses), assignee_id: id } : {}),
  });
  if (name === 'get.brief') return object({});
  if (name === 'get.project_money') return object({ project_id: id }, ['project_id']);
  if (name === 'create.task') return object({
    title: text(300), description: { type: 'string', maxLength: 8000 }, project_id: project, assignee_id: nullable(id),
    [source === 'pg' ? 'due_on' : 'due_at']: nullable(source === 'pg' ? date : instant),
  }, source === 'pg' ? ['title', 'project_id'] : ['title']);
  if (name === 'update.task_status') return object({ task_id: id, status: enumeration(statuses), expected_version: version }, ['task_id', 'status', 'expected_version']);
  if (name === 'create.event') return object({
    title: text(200), [source === 'pg' ? 'starts_at' : 'start_at']: instant,
    [source === 'pg' ? 'ends_at' : 'end_at']: instant, location: nullable({ type: 'string', maxLength: 500 }),
    ...(source === 'legacy' ? { project_id: project, calendar: enumeration(['personal', 'org', 'project']),
      attendee_ids: { type: 'array', items: id, maxItems: 50 } } : {}),
  }, source === 'pg' ? ['title', 'starts_at', 'ends_at'] : ['title', 'start_at', 'end_at']);
  if (name === 'create.document') return object({
    title: text(300), [source === 'pg' ? 'content_md' : 'content']: { type: 'string', maxLength: 16000 }, project_id: nullable(id),
    ...(source === 'legacy' ? { space_id: nullable(id) } : {}),
    visibility: enumeration(['org', 'private', 'public']),
    sensitivity: enumeration(['public', 'internal', 'personal', 'sensitive', 'confidential']),
  }, ['title']);
  if (name === 'confirm.transaction' && source === 'legacy') return object({ transaction_id: id, expected_version: version }, ['transaction_id', 'expected_version']);
  return object({});
}

function validator(schema) {
  if (schema.anyOf) return z.union(schema.anyOf.map(validator));
  if (schema.enum) return z.enum(schema.enum);
  if (schema.type === 'null') return z.null();
  if (schema.type === 'integer') return z.number().int().min(schema.minimum).max(schema.maximum);
  if (schema.type === 'array') return z.array(validator(schema.items)).max(schema.maxItems);
  if (schema.type === 'object') return z.object(Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => {
    const field = validator(value); return [key, schema.required.includes(key) ? field : field.optional()];
  }))).strict();
  let value = z.string().min(schema.minLength ?? 0).max(schema.maxLength);
  if (schema.pattern) value = value.regex(new RegExp(schema.pattern));
  if (schema.format === 'date') value = value.date();
  if (schema.format === 'date-time') value = value.datetime({ offset: true });
  return value;
}

export function parseInput(source, name, input) {
  if (Buffer.byteLength(JSON.stringify(input) ?? '') > 24000) throw new ApiError('VALIDATION_ERROR', '도구 입력이 너무 큽니다.');
  const parsed = validator(inputSchema(source, name)).safeParse(input);
  // 원문이나 비밀번호가 진단에 복사되지 않는다.
  if (!parsed.success) throw new ApiError('VALIDATION_ERROR', '도구 입력 형식이 올바르지 않습니다.');
  return parsed.data;
}

export function freshLegacyAgent(context) {
  if (context.source !== 'legacy' || !context.request) throw new ApiError('UNAUTHENTICATED', '서버 인증 문맥이 필요합니다.');
  if (!['personal', 'company'].includes(context.knowledgeMode)) throw new ApiError('VALIDATION_ERROR', '지식 모드를 선택하세요.');
  const req = context.request;
  delete req.principal;
  delete req.appUser;
  const p = resolvePrincipal(req);
  if ((context.actorId && String(context.actorId) !== p.userId) || (context.workspaceId && context.workspaceId !== p.orgId)) throw notFound('agent context');
  p.modules = [...enabledSet(req.organization.modules)];
  p.features = [...enabledFeatureSet(req.organization.enabled_features, req.organization.modules)];
  p.knowledgeMode = context.knowledgeMode;
  p.require('agent.chat'); p.require('menu.agent');
  if (!p.modules.includes('agent')) throw new ApiError('MODULE_DISABLED', 'AI 모듈이 비활성화되어 있습니다.');
  return p;
}

export async function freshPgAgent(context, client) {
  if (context.source !== 'pg' || !context.request) throw new ApiError('UNAUTHENTICATED', '서버 인증 문맥이 필요합니다.');
  if (!['personal', 'company'].includes(context.knowledgeMode)) throw new ApiError('VALIDATION_ERROR', '지식 모드를 선택하세요.');
  const identity = pgIdentity(context.request);
  const selected = context.request.get('x-org-id');
  if (!/^pg:[1-9]\d*$/.test(selected ?? '')) throw new ApiError('PERMISSION_DENIED', '회사를 선택하세요.');
  const companyId = selected.slice(3), userId = String(identity.userId);
  if ((context.actorId && String(context.actorId) !== userId) || (context.workspaceId && String(context.workspaceId) !== companyId)) throw notFound('agent context');
  // 회사 변경/역할 변경 서비스와 같은 잠금 순서로 권한 확인과 실행을 묶는다.
  await client.query('SELECT id FROM org.companies WHERE id=$1 FOR UPDATE', [companyId]);
  const membership = (await client.query(`SELECT m.user_id FROM org.company_memberships m
    JOIN auth.users u ON u.id=m.user_id JOIN org.companies c ON c.id=m.company_id
    WHERE m.company_id=$1 AND m.user_id=$2 AND m.status='active' AND c.is_active
      AND u.account_status='active' AND u.approval_status='approved' FOR SHARE OF m,u`, [companyId, userId])).rows[0];
  if (!membership) throw new ApiError('PERMISSION_DENIED', '현재 회사 소속이 없습니다.');
  const grants = (await client.query(`SELECT r.name AS role,p.code FROM org.user_roles ur
    JOIN org.roles r ON r.id=ur.role_id AND r.company_id=$1 AND r.deleted_at IS NULL
    JOIN org.role_permissions rp ON rp.role_id=r.id JOIN org.permissions p ON p.id=rp.permission_id
    WHERE ur.user_id=$2 AND ur.workspace_id IS NULL`, [companyId, userId])).rows;
  const permissions = effectivePgPermissions(grants);
  const modules = [...CORE_MODULES, ...(await client.query('SELECT module_key FROM org.company_modules WHERE company_id=$1', [companyId])).rows.map(row => row.module_key)];
  const settings = (await client.query('SELECT enabled_features FROM org.company_feature_settings WHERE company_id=$1', [companyId])).rows[0];
  const p = { companyId, userId, orgId: `pg:${companyId}`, knowledgeMode: context.knowledgeMode, scope: 'all', roles: [...new Set(grants.map(row => row.role))],
    modules, features: [...enabledFeatureSet(settings?.enabled_features, modules)], permissions,
    has: code => permissions.includes(code), require(code) { if (!this.has(code)) throw new ApiError('PERMISSION_DENIED', '현재 작업 권한이 없습니다.'); } };
  p.require('agent.chat'); p.require('menu.agent');
  if (!modules.includes('agent')) throw new ApiError('MODULE_DISABLED', 'AI 모듈이 비활성화되어 있습니다.');
  return p;
}

function capability(source, p, tool) {
  const [menu, module] = targets[tool.resource] ?? ['agent', 'agent'];
  const permissions = [tool.permission, ...(tool.name === 'get.project_money' ? ['transaction.read', 'budget.read'] : []),
    ...(tool.name === 'confirm.transaction' ? ['approval.request', 'transaction.read'] : [])];
  const menus = [`menu.${menu}`, ...(tool.name === 'get.project_money' ? ['menu.finance'] : []),
    ...(tool.requires_approval ? ['menu.approvals'] : [])];
  const modules = [module, ...(tool.name === 'get.project_money' ? ['finance'] : [])];
  const features = tool.requires_approval ? ['approvals'] : [];
  const implemented = supported.has(tool.name) && !(source === 'pg' && tool.name === 'confirm.transaction');
  const authorized = permissions.every(code => p.has(code)) && menus.every(code => p.has(code))
    && modules.every(key => p.modules.includes(key)) && features.every(key => p.features.includes(key));
  return { ...tool, input_schema: inputSchema(source, tool.name), authorized,
    recommended: PRESETS[presetFor(p.roles)].tools.includes(tool.name), implemented, callable: implemented && authorized,
    unavailable_reason: !implemented ? '이 저장소에서 구현되지 않은 기능입니다.' : !authorized ? '현재 권한 또는 기능 설정에서 사용할 수 없습니다.' : null,
    target_permissions: permissions, target_menus: menus, target_modules: modules, target_features: features,
    requires_confirmation: tool.stage !== 'read' };
}

export function authorizeCapability(source, p, name, stage) {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!tool) throw new ApiError('VALIDATION_ERROR', '등록되지 않은 도구입니다.');
  const item = capability(source, p, tool);
  if (!item.callable) throw new ApiError('PERMISSION_DENIED', item.unavailable_reason);
  if (stage && tool.stage !== stage) throw new ApiError('VALIDATION_ERROR', '이 경로에서 사용할 수 없는 도구입니다.');
  return item;
}

export async function catalog(context) {
  if (context.source === 'legacy') {
    const p = freshLegacyAgent(context); return Object.values(TOOLS).map(tool => capability('legacy', p, tool));
  }
  return pgTransaction(async client => { const p = await freshPgAgent(context, client); return Object.values(TOOLS).map(tool => capability('pg', p, tool)); });
}

function legacyRows(p, name, input) {
  const limit = input.limit ?? 20;
  const table = { 'search.documents': 'document', 'search.tasks': 'task', 'search.events': 'event',
    'search.transactions': 'transaction_record', 'search.projects': 'project' }[name];
  if (name === 'search.members') return db().prepare(`SELECT u.id,u.name,m.status FROM membership m JOIN app_user u ON u.id=m.user_id
    WHERE m.tenant_id=? AND m.org_id=? AND m.status='active' AND m.deleted_at IS NULL AND u.auth_status='active'
    AND u.name LIKE ? ORDER BY u.name,u.id LIMIT ?`).all(p.tenantId, p.orgId, `%${input.query ?? ''}%`, limit + 1);
  const filters = [];
  if (input.project_id) { getScoped('project', p, input.project_id); filters.push({ sql: 'project_id=?', params: [input.project_id] }); }
  if (input.status) filters.push({ sql: 'status=?', params: [input.status] });
  if (input.assignee_id) filters.push({ sql: 'assignee_id=?', params: [input.assignee_id] });
  if (input.query) filters.push({ sql: `${name === 'search.projects' ? 'name' : name === 'search.transactions' ? 'memo' : 'title'} LIKE ?`, params: [`%${input.query}%`] });
  if (p.scope !== 'all' && name === 'search.transactions') filters.push({ sql: 'created_by=?', params: [p.userId] });
  if (p.scope !== 'all' && name === 'search.tasks') filters.push({ sql: '(created_by=? OR assignee_id=?)', params: [p.userId, p.userId] });
  if (name === 'search.events') filters.push(p.knowledgeMode === 'company'
    ? { sql: "calendar<>'personal'", params: [] } : { sql: "(calendar<>'personal' OR created_by=?)", params: [p.userId] });
  if (name === 'search.documents') {
    if (p.knowledgeMode === 'company') filters.push({ sql: "visibility<>'private' AND sensitivity<>'personal'", params: [] });
    filters.push({ sql: "archived=0 AND (visibility<>'private' OR owner_id=?)", params: [p.userId] });
    return listScoped(table, p, filters, { limit: 501 }).filter(row => canReadDocument(p, row)).slice(0, limit + 1)
      .map(row => ({ id: row.id, title: row.title, content: row.content.slice(0, 4000), sensitivity: row.sensitivity, version: row.version, project_id: row.project_id }));
  }
  const fields = {
    'search.tasks': ['id', 'project_id', 'title', 'description', 'assignee_id', 'status', 'due_at', 'version'],
    'search.events': ['id', 'project_id', 'title', 'start_at', 'end_at', 'location', 'version'],
    'search.transactions': ['id', 'project_id', 'memo', 'kind', 'amount_minor', 'currency', 'occurred_on', 'status', 'version'],
    'search.projects': ['id', 'name', 'description', 'status', 'version'],
  }[name];
  return listScoped(table, p, filters, { limit: limit + 1 }).map(row => Object.fromEntries(fields.map(key => [key, row[key] ?? null])));
}

async function pgRows(client, p, name, input) {
  if (name === 'search.documents') return (await listPgDocuments(client, p, {
    query: input.query, limit: (input.limit ?? 20) + 1, projectId: input.project_id,
  })).map(row => ({ id: row.id, project_id: row.project_id, title: row.title, content_md: row.content.slice(0,4000),
    version: row.version, sensitivity: row.sensitivity, visibility: row.visibility }));
  const params = [p.companyId, `%${input.query ?? ''}%`, (input.limit ?? 20) + 1];
  const projectFilter = input.project_id ? ` AND ${name === 'search.transactions' ? 't' : 'p'}.id=$${params.push(input.project_id)}` : '';
  const queries = {
    'search.projects': `SELECT p.id::text,p.name,p.description,p.status,p.version FROM project.projects p WHERE p.company_id=$1 AND p.name ILIKE $2 ORDER BY p.id LIMIT $3`,
    'search.members': `SELECT u.id::text,u.name,m.status FROM org.company_memberships m JOIN auth.users u ON u.id=m.user_id WHERE m.company_id=$1
      AND m.status='active' AND u.account_status='active' AND u.approval_status='approved' AND u.name ILIKE $2 ORDER BY u.id LIMIT $3`,
    'search.tasks': `SELECT t.id::text,t.project_id::text,t.title,t.description,t.assignee_id::text,t.status,to_char(t.due_on,'YYYY-MM-DD') AS due_on,t.version
      FROM project.tasks t JOIN project.projects p ON p.id=t.project_id WHERE p.company_id=$1 AND t.title ILIKE $2${projectFilter}
      ${input.status ? `AND t.status=$${params.push(input.status)}` : ''}${input.assignee_id ? ` AND t.assignee_id=$${params.push(input.assignee_id)}` : ''} ORDER BY t.id LIMIT $3`,
    'search.events': `SELECT t.id::text,t.title,t.starts_at,t.ends_at,t.location,t.version FROM calendar.events t
      WHERE t.company_id=$1 AND t.title ILIKE $2 AND t.cancelled_at IS NULL
      AND (t.scope='company' OR (t.scope='private' AND t.owner_id=$${params.length + 1} AND $${params.length + 2}='personal'))
      ORDER BY t.id LIMIT $3`,
    'search.transactions': `SELECT t.id::text,t.project_id::text,t.memo,to_char(t.entry_date,'YYYY-MM-DD') AS entry_date,t.posted,t.version,
      COALESCE(SUM(l.debit),0)::text AS debit,COALESCE(SUM(l.credit),0)::text AS credit FROM accounting.journal_entries t
      LEFT JOIN accounting.journal_lines l ON l.entry_id=t.id WHERE t.company_id=$1 AND COALESCE(t.memo,'') ILIKE $2
      ${input.project_id ? `AND t.project_id=$4` : ''} GROUP BY t.id ORDER BY t.id LIMIT $3`,
  };
  if (name === 'search.events') {
    if (input.project_id) throw new ApiError('VALIDATION_ERROR', 'PG 일정은 프로젝트 필터를 지원하지 않습니다.');
    params.push(p.userId, p.knowledgeMode);
  }
  return (await client.query(queries[name], params)).rows;
}

function observation(name, input, rows) {
  const truncated = rows.length > (input.limit ?? 20);
  const items = rows.slice(0, input.limit ?? 20);
  return { result: { items }, evidence: items.map(row => ({ source: name, id: String(row.id) })),
    // 개인 가시성과 본문 분류는 별개다. 분류가 없는 PG 문서도 클라우드 안전 자료로 추측하지 않는다.
    classification: 'confidential', truncated };
}

async function queryAuthorized(context, name, raw) {
  const input = parseInput(context.source, name, raw);
  if (context.source === 'legacy') {
    const p = freshLegacyAgent(context); authorizeCapability('legacy', p, name, 'read');
    if (name === 'get.project_money') return { result: legacyProjectMoney({ ...context.request, params: { projectId: input.project_id } }), evidence: [{ source: name, id: input.project_id }], classification: 'confidential', truncated: false };
    if (name === 'get.brief') {
      const results = [];
      for (const tool of ['search.tasks', 'search.events']) if (capability('legacy', p, TOOLS[tool]).callable) results.push({ tool, ...observation(tool, { limit: 10 }, legacyRows(p, tool, { limit: 10 })) });
      return { result: { observations: results }, evidence: results.flatMap(row => row.evidence), classification: 'confidential', truncated: results.some(row => row.truncated) };
    }
    return observation(name, input, legacyRows(p, name, input));
  }
  // 프로젝트 자금 서비스는 자체 읽기 트랜잭션과 정확한 금액/행 범위 계약을 소유한다.
  if (name === 'get.project_money') {
    await pgTransaction(async client => authorizeCapability('pg', await freshPgAgent(context, client), name, 'read'));
    return { result: await pgProjectMoney({ ...context.request, params: { id: input.project_id } }), evidence: [{ source: name, id: input.project_id }], classification: 'confidential', truncated: false };
  }
  return pgTransaction(async client => {
    const p = await freshPgAgent(context, client); authorizeCapability('pg', p, name, 'read');
    if (name === 'get.brief') {
      const results = [];
      for (const tool of ['search.tasks', 'search.events']) if (capability('pg', p, TOOLS[tool]).callable) results.push({ tool, ...observation(tool, { limit: 10 }, await pgRows(client, p, tool, { limit: 10 })) });
      return { result: { observations: results }, evidence: results.flatMap(row => row.evidence), classification: 'confidential', truncated: results.some(row => row.truncated) };
    }
    return observation(name, input, await pgRows(client, p, name, input));
  });
}

export async function query(context, name, raw) {
  const observation = await queryAuthorized(context, name, raw);
  // 본문 분류를 낮추지 않는다. 회사 업무/프로젝트의 식별자와 CAS 버전만 별도 영수증으로 허용한다.
  const providerReceipt = { kind: 'protected_query', tool: name, status: 'protected_result', truncated: observation.truncated };
  if (name === 'search.tasks' || name === 'search.projects') {
    providerReceipt.items = observation.result.items.map(row => ({ id: String(row.id), version: row.version }));
  }
  return { ...observation, provider_receipt: providerReceipt };
}
