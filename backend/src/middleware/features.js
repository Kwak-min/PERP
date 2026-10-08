import { pgQuery } from "../config/pg.js";
import { assertFeatureEnabled, enabledFeatures } from "../config/features.js";
import { resolvePrincipal } from "./auth.js";

export function requireFeature(featureKey) {
  return (req, _res, next) => {
    resolvePrincipal(req);
    assertFeatureEnabled(featureKey, req.organization.enabled_features, req.organization.modules);
    next();
  };
}

export async function pgEnabledFeatures(companyId, modules) {
  try {
    const { rows } = await pgQuery(
      "SELECT enabled_features FROM org.company_feature_settings WHERE company_id = $1",
      [companyId],
    );
    return enabledFeatures(rows[0]?.enabled_features, modules);
  } catch (error) {
    // 배포 순서상 v6 적용 전에도 기존 회사의 hr/approvals 동작은 유지한다.
    if (error?.code === "42P01") return enabledFeatures(null, modules);
    throw error;
  }
}

export function withPgFeature(featureKey, handler) {
  return async (req, res) => {
    const principal = req.pgCompanyPrincipal;
    const features = await pgEnabledFeatures(principal.companyId, principal.modules);
    assertFeatureEnabled(featureKey, features, principal.modules);
    return handler(req, res);
  };
}
