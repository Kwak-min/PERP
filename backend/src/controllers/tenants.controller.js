import { z } from "zod";

import { db, transaction } from "../config/db.js";
import {
  enabledFeatures,
  FEATURE_CATALOG,
  modulesForFeatures,
  validateFeatureSelection,
} from "../config/features.js";
import { CORE_MODULES, MODULE_CATALOG, OPTIONAL_MODULES } from "../config/modules.js";
import { ORG_TEMPLATES } from "../config/org-templates.js";
import { currentUser, resolvePrincipal } from "../middleware/auth.js";
import { enabledSet, validateSelection } from "../middleware/modules.js";
import { bumpVersion, insert, newId, nowIso } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { ApiError, notFound } from "../utils/errors.js";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.string().default("club"),
  currency: z.string().default("KRW"),
  timezone: z.string().default("Asia/Seoul"),
  fiscal_year_start: z.number().int().min(1).max(12).default(1),
  modules: z.array(z.string()).nullable().optional(),
  features: z.array(z.string()).default([]),
  terminology: z.record(z.string()).nullable().optional(),
  departments: z.array(z.string()).nullable().optional(),
});

const updateSchema = z.object({
  name: z.string().optional(),
  fiscal_year_start: z.number().int().min(1).max(12).optional(),
  modules: z.array(z.string()).optional(),
  features: z.array(z.string()).optional(),
  terminology: z.record(z.string()).optional(),
}).strict();

export function effectiveTerminology(org) {
  const base = { ...(ORG_TEMPLATES[org.type]?.terminology ?? {}) };
  if (org.terminology_json) Object.assign(base, JSON.parse(org.terminology_json));
  return base;
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
    features: FEATURE_CATALOG,
  });
}

export function moduleCatalog(req, res) {
  const principal = resolvePrincipal(req);
  const org = db().prepare("SELECT * FROM organization WHERE id = ?").get(principal.orgId);
  const active = enabledSet(org?.modules ?? "");
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
    features: FEATURE_CATALOG.map((feature) => ({
      ...feature,
      enabled: enabledFeatures(org?.enabled_features, org?.modules).includes(feature.key),
    })),
  });
}

export function createOrg(req, res) {
  const payload = createSchema.parse(req.body);
  const user = currentUser(req);
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
  // 조직 유형은 부서 생성 동의가 아니다. 명시적으로 제출한 부서만 만든다.
  const departments = payload.departments ?? [];

  const features = validateFeatureSelection(payload.features);
  const selected = modulesForFeatures(validateSelection(
    payload.modules === null || payload.modules === undefined ? template.modules : payload.modules,
  ), features);

  const created = transaction(() => {
    const tenantId = newId();
    db()
    .prepare(
      `INSERT INTO tenant (id, name, type, status, plan_id, timezone, currency, created_at)
       VALUES (?, ?, ?, 'active', 'free', ?, ?, ?)`,
    )
    .run(tenantId, payload.name, payload.type, payload.timezone, payload.currency, nowIso());

    const org = insert("organization", {
      tenant_id: tenantId,
      name: payload.name,
      type: payload.type,
      terminology_profile: payload.type,
      terminology_json: isCustom ? JSON.stringify(terminology) : "",
      currency: payload.currency,
      timezone: payload.timezone,
      fiscal_year_start: payload.fiscal_year_start,
      modules: selected.join(","),
      enabled_features: features.join(","),
      created_by: user.id,
    });

  insert("membership", {
    tenant_id: tenantId,
    user_id: user.id,
    org_id: org.id,
    roles: "owner",
    status: "active",
    joined_at: nowIso(),
    created_by: user.id,
  });

  for (const name of departments) {
    insert("department", { tenant_id: tenantId, org_id: org.id, name, created_by: user.id });
  }
  for (const [code, accountName, kind] of template.accounts) {
    insert("account", {
      tenant_id: tenantId,
      org_id: org.id,
      code,
      name: accountName,
      kind,
      created_by: user.id,
    });
  }

  audit.record({
    tenantId,
    action: "organization.created",
    resourceType: "organization",
    resourceId: org.id,
    actorId: user.id,
    after: { name: org.name, type: org.type, enabled_features: features },
    requestId: req.requestId,
  });

    return { tenantId, org };
  })();

  res.status(201).json({
    tenant_id: created.tenantId,
    org_id: created.org.id,
    name: created.org.name,
    type: created.org.type,
    modules: selected,
    enabled_features: features,
    terminology,
  });
}

export function current(req, res) {
  const principal = resolvePrincipal(req);
  const org = db().prepare("SELECT * FROM organization WHERE id = ?").get(principal.orgId);
  if (!org) throw notFound("organization");
  res.json({
    org_id: org.id,
    tenant_id: org.tenant_id,
    name: org.name,
    type: org.type,
    modules: (org.modules ?? "").split(",").filter(Boolean),
    enabled_features: enabledFeatures(org.enabled_features, org.modules),
    terminology: effectiveTerminology(org),
    roles: principal.roles,
    permissions: [...principal.permissions].sort(),
  });
}

export function updateOrg(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("organization.settings");
  const payload = updateSchema.parse(req.body);

  const org = db().prepare("SELECT * FROM organization WHERE id = ?").get(principal.orgId);
  if (!org) throw notFound("organization");

  const before = {
    name: org.name,
    fiscal_year_start: org.fiscal_year_start,
    modules: org.modules,
    enabled_features: enabledFeatures(org.enabled_features, org.modules),
    terminology: effectiveTerminology(org),
  };

  const patch = {};
  if (payload.name !== undefined) patch.name = payload.name;
  if (payload.fiscal_year_start !== undefined) patch.fiscal_year_start = payload.fiscal_year_start;
  if (payload.modules !== undefined) patch.modules = validateSelection(payload.modules).join(",");
  if (payload.features !== undefined) {
    const features = validateFeatureSelection(payload.features);
    patch.enabled_features = features.join(",");
    patch.modules = modulesForFeatures((patch.modules ?? org.modules ?? "").split(",").filter(Boolean), features).join(",");
  }
  if (payload.terminology !== undefined) {
    const merged = effectiveTerminology(org);
    for (const [key, value] of Object.entries(payload.terminology)) {
      if (value) merged[key] = value;
    }
    patch.terminology_json = JSON.stringify(merged);
  }

  const updated = transaction(() => {
    const updated = bumpVersion("organization", org, patch, principal.userId);

    audit.record({
      tenantId: principal.tenantId,
      action: "organization.updated",
      resourceType: "organization",
      resourceId: org.id,
      actorId: principal.userId,
      before,
      after: {
        name: updated.name,
        fiscal_year_start: updated.fiscal_year_start,
        modules: updated.modules,
        enabled_features: enabledFeatures(updated.enabled_features, updated.modules),
        terminology: effectiveTerminology(updated),
      },
      requestId: req.requestId,
    });
    return updated;
  })();

  res.json({
    org_id: updated.id,
    name: updated.name,
    version: updated.version,
    modules: [...enabledSet(updated.modules)].sort(),
    enabled_features: enabledFeatures(updated.enabled_features, updated.modules),
    terminology: effectiveTerminology(updated),
  });
}

export function usage(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("organization.settings");
  const count = (table) =>
    db()
      .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ? AND org_id = ?`)
      .get(principal.tenantId, principal.orgId).c;
  const aiLogs = db()
    .prepare("SELECT cost_micro FROM ai_request_log WHERE tenant_id = ?")
    .all(principal.tenantId);
  res.json({
    members: count("membership"),
    projects: count("project"),
    tasks: count("task"),
    documents: count("document"),
    ai_requests: aiLogs.length,
    ai_cost_micro: aiLogs.reduce((sum, row) => sum + row.cost_micro, 0),
  });
}
