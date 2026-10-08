import { z } from 'zod';
import { db } from '../config/db.js';
import { pgTransaction } from '../config/pg.js';
import { ORG_TEMPLATES } from '../config/org-templates.js';
import { resolvePrincipal } from '../middleware/auth.js';
import { pgIdentity } from '../middleware/pgAccess.js';
import { insert } from '../models/base.js';
import { freshReceiptPrincipal } from '../services/legacy-receipt-files.service.js';
import { freshPgReceiptPrincipal } from '../services/pg-receipt-files.service.js';
import { recordEvent } from '../services/pg-finance.service.js';
import * as audit from '../services/audit.service.js';

const setupSchema = z.object({}).strict();
function status(principal, accounts, pg) {
  const missing = (pg ? ['cash', 'income', 'expense'] : ['income', 'expense']).filter(kind => !accounts.some(account => account.active && account.kind === kind));
  return { ready: missing.length === 0, can_initialize: principal.has('organization.settings'), missing };
}
function additions(type, accounts, missing) {
  const template = ORG_TEMPLATES[type]?.accounts ?? [];
  const defaults = [['1000', '현금', 'cash'], ['4100', '수입', 'income'], ['5100', '지출', 'expense']];
  const codes = new Set(accounts.map(account => account.code));
  return missing.flatMap(kind => {
    const candidates = template.filter(row => row[2] === kind);
    return (candidates.length ? candidates : defaults.filter(row => row[2] === kind)).map(([preferred, name, direction]) => {
      // 사용 중이거나 비활성인 계정의 코드/분류를 덮어쓰지 않는다.
      let code = preferred, suffix = 1;
      while (codes.has(code)) code = `${preferred}-setup-${suffix++}`;
      codes.add(code); return { code, name, kind: direction };
    });
  });
}

export function legacySetup(req, res) {
  const initialize = req.method === 'POST';
  if (initialize) setupSchema.parse(req.body);
  const identity = resolvePrincipal(req);
  db().exec('BEGIN IMMEDIATE');
  try {
    const principal = freshReceiptPrincipal(identity, 'transaction');
    principal.require('transaction.read');
    if (initialize) principal.require('organization.settings');
    const scope = [principal.tenantId, principal.orgId];
    const readAccounts = () => db().prepare('SELECT code,name,kind,active FROM account WHERE tenant_id=? AND org_id=? AND deleted_at IS NULL').all(...scope);
    const accounts = readAccounts(), before = status(principal, accounts, false);
    if (initialize && !before.ready) {
      const org = db().prepare('SELECT type FROM organization WHERE tenant_id=? AND id=?').get(...scope);
      const created = additions(org.type, accounts, before.missing).map(account => insert('account', { ...account, tenant_id: principal.tenantId, org_id: principal.orgId, created_by: principal.userId }));
      audit.record({ tenantId: principal.tenantId, actorId: principal.userId, action: 'finance.initialized', resourceType: 'organization', resourceId: principal.orgId, before, after: { created_accounts: created }, requestId: req.requestId });
    }
    const result = status(principal, readAccounts(), false);
    db().exec('COMMIT'); res.json(result);
  } catch (error) { db().exec('ROLLBACK'); throw error; }
}

export async function pgSetup(req, res) {
  const initialize = req.method === 'POST';
  if (initialize) setupSchema.parse(req.body);
  const result = await pgTransaction(async client => {
    const principal = await freshPgReceiptPrincipal(client, pgIdentity(req), 'transaction', true);
    if (initialize) principal.require('organization.settings');
    const readAccounts = async () => (await client.query(`SELECT code,name,CASE account_type WHEN 'asset' THEN 'cash' WHEN 'revenue' THEN 'income' ELSE account_type END AS kind,is_active AS active FROM accounting.accounts WHERE company_id=$1`, [principal.companyId])).rows;
    const accounts = await readAccounts(), before = status(principal, accounts, true);
    if (initialize && !before.ready) {
      const { rows: [company] } = await client.query("SELECT to_jsonb(c)->>'organization_type' AS type FROM org.companies c WHERE id=$1", [principal.companyId]);
      const created = [];
      for (const account of additions(company.type, accounts, before.missing)) {
        const { rows: [saved] } = await client.query('INSERT INTO accounting.accounts(company_id,code,name,account_type) VALUES($1,$2,$3,$4) RETURNING id,code,name,account_type', [principal.companyId, account.code, account.name, { cash: 'asset', income: 'revenue', expense: 'expense' }[account.kind]]);
        created.push(saved);
      }
      await recordEvent(client, req, 'finance_setup', principal.companyId, before, { created_accounts: created });
    }
    return status(principal, await readAccounts(), true);
  });
  res.json(result);
}
