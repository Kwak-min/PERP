import { ApiError } from "../utils/errors.js";

export const FEATURE_CATALOG = [
  {
    key: "attendance",
    label: "근태",
    description: "출퇴근, 근태 기록과 수정 요청을 사용합니다.",
  },
  {
    key: "leave",
    label: "휴가",
    description: "휴가 신청, 잔여일과 승인 관리를 사용합니다.",
  },
  {
    key: "approvals",
    label: "전자결재",
    description: "결재 양식, 결재선과 승인·반려를 사용합니다.",
  },
];

export const FEATURE_KEYS = FEATURE_CATALOG.map((feature) => feature.key);
const FEATURE_KEY_SET = new Set(FEATURE_KEYS);

export function validateFeatureSelection(keys) {
  const unknown = keys.filter((key) => !FEATURE_KEY_SET.has(key));
  if (unknown.length > 0) {
    throw new ApiError("VALIDATION_ERROR", `알 수 없는 기능: ${unknown.join(", ")}`, {
      unknown,
      available: FEATURE_KEYS,
    });
  }
  return [...new Set(keys)];
}

function selectedModules(storedModules) {
  const values = Array.isArray(storedModules)
    ? storedModules
    : String(storedModules ?? "").split(",");
  return new Set(values.filter(Boolean));
}

// NULL/설정 행 없음은 이 기능 분리 이전 조직이다. 기존 hr/approvals 동작을 그대로 보존한다.
export function enabledFeatureSet(configuredFeatures, storedModules) {
  if (configuredFeatures !== null && configuredFeatures !== undefined) {
    const values = Array.isArray(configuredFeatures)
      ? configuredFeatures
      : String(configuredFeatures).split(",");
    return new Set(values.filter((key) => FEATURE_KEY_SET.has(key)));
  }
  const modules = selectedModules(storedModules);
  return new Set([
    ...(modules.has("hr") ? ["attendance", "leave"] : []),
    ...(modules.has("approvals") ? ["approvals"] : []),
  ]);
}

export function enabledFeatures(configuredFeatures, storedModules) {
  return [...enabledFeatureSet(configuredFeatures, storedModules)].sort();
}

export function modulesForFeatures(modules, features) {
  const selected = new Set(modules.filter((module) => module !== "approvals"));
  if (features.includes("approvals")) selected.add("approvals");
  return [...selected];
}

export function assertFeatureEnabled(featureKey, configuredFeatures, storedModules) {
  if (enabledFeatureSet(configuredFeatures, storedModules).has(featureKey)) return;
  const feature = FEATURE_CATALOG.find((item) => item.key === featureKey);
  throw new ApiError(
    "FEATURE_DISABLED",
    `이 조직에서 '${feature?.label ?? featureKey}' 기능이 꺼져 있습니다`,
    { feature: featureKey, enable_at: "조직 설정 > 기능" },
  );
}
