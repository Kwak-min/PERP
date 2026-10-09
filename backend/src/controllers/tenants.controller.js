import { z } from "zod";

import { CORE_MODULES, MODULE_CATALOG, OPTIONAL_MODULES } from "../config/modules.js";
import { ORG_TEMPLATES } from "../config/org-templates.js";
import { resolvePrincipal } from "../middleware/auth.js";
import { enabledSet, validateSelection } from "../middleware/modules.js";
import { pgQuery, pgTransaction } from "../config/pg.js";
import { ApiError, notFound } from "../utils/errors.js";

// perp_db(org.*) 전용 조직(tenants) 컨트롤러.
// SQLite(config/db, models/base, node:sqlite, services/audit)를 전혀 쓰지 않는다.
// 모든 조회/쓰기는 company_id = principal.orgId 로 스코프.
//
// 핵심 매핑(프론트 수정 금지):
//   org_id      <- org.companies.id (문자열)
//   tenant_id   <- org.companies.id (perp_db 엔 별도 tenant 개념이 없어 company_id 로 대체)
//   type        <- org.companies.organization_type
//   name        <- org.companies.name
//   modules     <- org.company_modules.module_key (+ 코어 모듈) — enabledSet
//   terminology <- org-templates(organization_type) 기반(회사별 저장소 없음)
//   roles       <- principal.roles,  permissions <- principal.permissions
//
// perp_db org.companies 에는 currency/timezone/fiscal_year_start/terminology 컬럼이
// 없으므로 해당 입력은 받되 저장하지 않는다(프론트 호환용).
// organization_type CHECK: {company, personal, club, lab} 만 허용.

// org.companies.organization_type CHECK 에 허용된 값만 저장 가능.
const DB_ORG_TYPES = new Set(["company", "personal", "club", "lab"]);
const dbOrgType = (type) => (DB_ORG_TYPES.has(type) ? type : "club");

const createSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.string().default("club"),
  currency: z.string().default("KRW"),
  timezone: z.string().default("Asia/Seoul"),
  fiscal_year_start: z.number().int().min(1).max(12).default(1),
  modules: z.array(z.string()).nullable().optional(),
  terminology: z.record(z.string()).nullable().optional(),
  departments: z.array(z.string()).nullable().optional(),
});

const updateSchema = z.object({
  name: z.string().optional(),
  fiscal_year_start: z.number().int().min(1).max(12).optional(),
  modules: z.array(z.string()).optional(),
  terminology: z.record(z.string()).optional(),
});

// organization_type 기준 템플릿 용어. (회사별 저장소가 없어 템플릿이 곧 유효 용어)
export function terminologyFor(type) {
  return { ...(ORG_TEMPLATES[type]?.terminology ?? ORG_TEMPLATES.custom.terminology) };
}

// 레거시 호환 export: org row(organization_type 보유)를 받아 유효 용어 반환.
export function effectiveTerminology(org) {
  return terminologyFor(org?.organization_type ?? org?.type);
}

export function templates(_req, res) {
  res.json({
    items: Object.entries(ORG_TEMPLATES).map(([type, value]) => ({
      type,
      terminology: value.terminology,
      modules: value.modules,
      departments: value.departments,
      custom: value.custom === true,
    })),
  });
}

export function publicModuleCatalog(_req, res) {
  res.json({
    items: MODULE_CATALOG.map((m) => ({
      key: m.key,
      label: m.label,
      core: m.core,
      description: m.description,
    })),
    core: [...CORE_MODULES].sort(),
    optional: OPTIONAL_MODULES,
  });
}

// 회사의 활성 모듈 키(코어 포함) 집합.
async function loadModuleSet(orgId) {
  if (!orgId) return enabledSet("");
  const { rows } = await pgQuery(
    "SELECT module_key FROM org.company_modules WHERE company_id::text = $1",
    [orgId],
  );
  return enabledSet(rows.map((r) => r.module_key).join(","));
}

async function loadCompany(orgId) {
  if (!orgId) throw notFound("organization");
  const { rows } = await pgQuery(
    `SELECT id, name, organization_type, org_revision
       FROM org.companies WHERE id::text = $1`,
    [orgId],
  );
  if (rows.length === 0) throw notFound("organization");
  return rows[0];
}

export async function moduleCatalog(req, res) {
  const principal = resolvePrincipal(req);
  const active = await loadModuleSet(principal.orgId);
  res.json({
    items: MODULE_CATALOG.map((m) => ({
      key: m.key,
      label: m.label,
      core: m.core,
      description: m.description,
      enabled: active.has(m.key),
    })),
    core: [...CORE_MODULES].sort(),
    optional: OPTIONAL_MODULES,
  });
}

export async function createOrg(req, res) {
  const payload = createSchema.parse(req.body);
  const principal = resolvePrincipal(req);
  const template = ORG_TEMPLATES[payload.type];
  if (!template) {
    throw new ApiError("VALIDATION_ERROR", `unknown organization type: ${payload.type}`);
  }

  const isCustom = template.custom === true;
  const terminology = { ...template.terminology };
  if (isCustom && payload.terminology) {
    for (const [key, value] of Object.entries(payload.terminology)) {
      if (value) terminology[key] = value;
    }
  }
  const departments =
    isCustom && payload.departments !== null && payload.departments !== undefined
      ? payload.departments
      : template.departments;

  const selected = validateSelection(
    payload.modules === null || payload.modules === undefined ? template.modules : payload.modules,
  );

  const company = await pgTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO org.companies (name, organization_type)
       VALUES ($1, $2)
       RETURNING id, name, organization_type`,
      [payload.name, dbOrgType(payload.type)],
    );
    const created = rows[0];

    await client.query(
      `INSERT INTO org.company_memberships (company_id, user_id, status, created_by)
       VALUES ($1, $2::bigint, 'active', $2::bigint)
       ON CONFLICT (company_id, user_id) DO NOTHING`,
      [created.id, principal.userId],
    );

    for (const key of selected) {
      await client.query(
        `INSERT INTO org.company_modules (company_id, module_key)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [created.id, key],
      );
    }

    for (const name of departments) {
      await client.query(
        `INSERT INTO org.departments (company_id, name)
         VALUES ($1, $2)
         ON CONFLICT (company_id, name) DO NOTHING`,
        [created.id, name],
      );
    }
    return created;
  });

  res.status(201).json({
    tenant_id: String(company.id),
    org_id: String(company.id),
    name: company.name,
    type: company.organization_type,
    modules: selected,
    terminology,
  });
}

export async function current(req, res) {
  const principal = resolvePrincipal(req);
  const company = await loadCompany(principal.orgId);
  const active = await loadModuleSet(principal.orgId);
  res.json({
    org_id: String(company.id),
    tenant_id: String(company.id),
    name: company.name,
    type: company.organization_type,
    modules: [...active].sort(),
    terminology: terminologyFor(company.organization_type),
    roles: principal.roles,
    permissions: [...principal.permissions].sort(),
  });
}

export async function updateOrg(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("organization.settings");
  const payload = updateSchema.parse(req.body);
  const company = await loadCompany(principal.orgId);

  const updated = await pgTransaction(async (client) => {
    let name = company.name;
    if (payload.name !== undefined) {
      const { rows } = await client.query(
        `UPDATE org.companies
            SET name = $1, org_revision = org_revision + 1, updated_at = now()
          WHERE id = $2
          RETURNING name`,
        [payload.name, company.id],
      );
      name = rows[0].name;
    }

    if (payload.modules !== undefined) {
      const selected = validateSelection(payload.modules);
      await client.query(`DELETE FROM org.company_modules WHERE company_id = $1`, [company.id]);
      for (const key of selected) {
        await client.query(
          `INSERT INTO org.company_modules (company_id, module_key)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [company.id, key],
        );
      }
    }
    // fiscal_year_start / terminology: perp_db 에 저장 컬럼이 없어 무시(프론트 호환용).
    return { name };
  });

  const active = await loadModuleSet(principal.orgId);
  res.json({
    org_id: String(company.id),
    name: updated.name,
    version: Number(company.org_revision) + (payload.name !== undefined ? 1 : 0),
    modules: [...active].sort(),
    terminology: terminologyFor(company.organization_type),
  });
}

export async function usage(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("organization.settings");
  const orgId = principal.orgId;

  const [members, projects, tasks, documents] = await Promise.all([
    pgQuery("SELECT COUNT(*)::int AS c FROM org.company_memberships WHERE company_id::text = $1", [
      orgId,
    ]),
    pgQuery("SELECT COUNT(*)::int AS c FROM project.projects WHERE company_id::text = $1", [orgId]),
    pgQuery(
      `SELECT COUNT(*)::int AS c
         FROM project.tasks t
         JOIN project.projects p ON p.id = t.project_id
        WHERE p.company_id::text = $1`,
      [orgId],
    ),
    pgQuery(
      `SELECT COUNT(*)::int AS c
         FROM project.documents d
         JOIN project.projects p ON p.id = d.project_id
        WHERE p.company_id::text = $1`,
      [orgId],
    ),
  ]);

  res.json({
    members: members.rows[0].c,
    projects: projects.rows[0].c,
    tasks: tasks.rows[0].c,
    documents: documents.rows[0].c,
    // perp_db 에 회사 스코프 AI 요청/비용 집계 테이블이 없어 0 고정.
    ai_requests: 0,
    ai_cost_micro: 0,
  });
}
