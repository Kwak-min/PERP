import { BY_KEY, CORE_MODULES } from "../config/modules.js";
import { ApiError } from "../utils/errors.js";
import { resolvePrincipal } from "./auth.js";

export function enabledSet(stored) {
  const selected = (stored ?? "").split(",").filter(Boolean);
  return new Set([...CORE_MODULES, ...selected]);
}

export function assertEnabled(moduleKey, stored) {
  if (CORE_MODULES.has(moduleKey)) return;
  if (!enabledSet(stored).has(moduleKey)) {
    const spec = BY_KEY[moduleKey];
    throw new ApiError(
      "MODULE_DISABLED",
      `이 조직에서 '${spec?.label ?? moduleKey}' 모듈이 꺼져 있습니다`,
      { module: moduleKey, enable_at: "조직 설정 > 모듈" },
    );
  }
}

export function validateSelection(keys) {
  const unknown = keys.filter((k) => !(k in BY_KEY));
  if (unknown.length > 0) {
    throw new ApiError("VALIDATION_ERROR", `알 수 없는 모듈: ${unknown.join(", ")}`, {
      unknown,
      available: Object.keys(BY_KEY).filter((k) => !CORE_MODULES.has(k)),
    });
  }
  return [...new Set(keys)].filter((k) => !CORE_MODULES.has(k));
}

export function requireModule(moduleKey) {
  return (req, _res, next) => {
    resolvePrincipal(req);
    assertEnabled(moduleKey, req.organization?.modules ?? "");
    next();
  };
}
