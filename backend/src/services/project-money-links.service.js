import { db } from '../config/db.js';
import { getScoped } from '../models/base.js';
import { ApiError, notFound } from '../utils/errors.js';
import { freshPgReceiptPrincipal } from './pg-receipt-files.service.js';

export function requireProjectMoneyScope(principal, project) {
  principal.require('menu.projects'); principal.require('project.read');
  const org = db().prepare('SELECT modules FROM organization WHERE tenant_id=? AND id=?').get(principal.tenantId, principal.orgId);
  if (!org.modules.split(',').includes('projects')) throw new ApiError('MODULE_DISABLED', '프로젝트 모듈이 비활성화되어 있습니다.');
  if (principal.scope === 'all') return;
  if (principal.scope === 'project' && db().prepare(`SELECT 1 FROM project_member
    WHERE tenant_id=? AND project_id=? AND user_id=? AND deleted_at IS NULL`).get(principal.tenantId, project.id, principal.userId)) return;
  // 일부 행만으로 전체 프로젝트의 잔여 예산을 합성하지 않는다.
  throw new ApiError('PERMISSION_DENIED', '프로젝트 전체 재무를 조회할 수 있는 데이터 범위가 필요합니다.');
}

// caller의 write transaction 안에서 사용한다. 예산 선택은 신규 전표에만 프로젝트를 기록한다.
export function legacyMoneyLinks(principal, payload) {
  const budget = payload.budget_id ? getScoped('budget', principal, payload.budget_id) : null;
  const projectId = payload.project_id ?? budget?.project_id ?? null;
  if (payload.project_id) getScoped('project', principal, payload.project_id);
  if (budget && payload.project_id && budget.project_id !== payload.project_id) throw new ApiError('VALIDATION_ERROR', '선택한 예산과 프로젝트가 일치하지 않습니다.');
  if (projectId) {
    const project = getScoped('project', principal, projectId);
    requireProjectMoneyScope(principal, project);
  }
  if (budget && principal.scope !== 'all' && budget.created_by !== principal.userId) throw notFound('budget');
  if (budget?.money_currency && payload.input_currency && budget.money_currency !== payload.input_currency) throw new ApiError('VALIDATION_ERROR', '예산과 거래의 통화가 일치하지 않습니다.');
  return { projectId, budget };
}

export async function requirePgProjectMoneyAccess(client, principal) {
  principal.require('menu.projects'); principal.require('project.read');
  const enabled = (await client.query("SELECT 1 FROM org.company_modules WHERE company_id=$1 AND module_key='projects'", [principal.companyId])).rows.length;
  if (!enabled) throw new ApiError('MODULE_DISABLED', '프로젝트 모듈이 비활성화되어 있습니다.');
}

export async function pgMoneyLinks(client, identity, payload, fresh = null) {
  const id = value => { if (!/^[1-9]\d*$/.test(String(value))) throw new ApiError('VALIDATION_ERROR', '유효한 프로젝트와 예산을 선택하세요.'); return value; };
  let budget = null;
  if (payload.budget_id) {
    budget = (await client.query('SELECT * FROM accounting.budgets WHERE company_id=$1 AND id=$2 FOR SHARE', [identity.companyId, id(payload.budget_id)])).rows[0];
    if (!budget) throw new ApiError('VALIDATION_ERROR', '현재 회사의 예산을 선택하세요.');
  }
  const projectId = payload.project_id ?? budget?.project_id ?? null;
  if (projectId) {
    const project = (await client.query('SELECT id FROM project.projects WHERE company_id=$1 AND id=$2 FOR SHARE', [identity.companyId, id(projectId)])).rows[0];
    if (!project) throw notFound('project');
    const principal = fresh ?? await freshPgReceiptPrincipal(client, identity, 'transaction');
    await requirePgProjectMoneyAccess(client, principal);
  }
  if (budget && payload.project_id && String(budget.project_id) !== String(payload.project_id)) throw new ApiError('VALIDATION_ERROR', '선택한 예산과 프로젝트가 일치하지 않습니다.');
  if (budget?.money_currency && payload.input_currency && budget.money_currency !== payload.input_currency) throw new ApiError('VALIDATION_ERROR', '예산과 거래의 통화가 일치하지 않습니다.');
  return { projectId: projectId === null ? null : String(projectId), budget };
}
