// 저장소 선택은 사용자가 고른 조직으로만 결정한다. 오류 시 다른 DB로 재시도하지 않는다.
export function isPgWorkspace(orgId: string | null | undefined): boolean {
  return Boolean(orgId?.startsWith("pg:"));
}

const legacyEndpoints: Readonly<Record<string, string>> = {
  "/pg/usage": "/tenants/usage",
  '/pg/notifications': '/notifications',
  "/pg/finance/summary": "/finance/reports/summary",
  "/pg/finance/dues": "/finance/dues/charges",
  "/pg/approvals": "/approvals/requests",
  "/pg/automation/runs": "/automations/runs",
};

export function workspaceEndpoint(path: string, orgId: string | null | undefined): string {
  if (isPgWorkspace(orgId) || !orgId || !path.startsWith("/pg/") || path.startsWith("/pg/auth/") || path.startsWith("/pg/vault/")) return path;
  const split = path.indexOf("?");
  const base = split < 0 ? path : path.slice(0, split);
  const query = split < 0 ? "" : path.slice(split);
  const exact = legacyEndpoints[base];
  if (exact) return exact + query;
  // 두 슬라이스가 같은 DTO를 쓰는 조회/전용 화면 계약만 명시적으로 선택한다.
  if (/^\/pg\/(members|projects|tasks|calendar|documents|assets|hr|agent|analytics)(\/|$)/.test(base) || /^\/pg\/finance\/(transactions|budgets|settlements)(\/|$)/.test(base)) return base.slice(3) + query;
  return path;
}
