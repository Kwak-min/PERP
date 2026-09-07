// 메뉴 접근과 동작 권한은 별개다. 사용자 정의 역할은 메뉴를 명시적으로 선택한다.
export const MENU_CATALOG = [
  ['home', '홈', 'member.read'], ['members', '구성원/조직도', 'member.read', 'member.write', 'department.write'],
  ['projects', '프로젝트/업무', 'project.read', 'task.read', 'project.write', 'task.write'], ['calendar', '캘린더', 'event.read'],
  ['finance', '재무', 'transaction.read', 'budget.read', 'dues.read'], ['assets', '자산', 'asset.read'],
  ['attendance', '근태', 'attendance.read', 'member.read'], ['leave', '휴가', 'member.read', 'leave.approve'],
  ['recruitment', '모집', 'recruitment.manage'], ['documents', '문서', 'document.read'],
  ['knowledge', '조직 지식 그래프', 'document.read'], ['vault', '개인 노트', 'agent.chat'],
  ['vault_graph', '개인 그래프', 'agent.chat'], ['approvals', '결재', 'approval.request', 'approval.decide'],
  ['agent', 'AI Agent', 'agent.chat'], ['analytics', '분석', 'analytics.read'],
  ['notifications', '알림', 'notification.read'], ['handover', '인수인계', 'handover.read'],
  ['automations', '자동화', 'automation.manage'], ['integrations', '외부 연동', 'integration.manage'],
  ['imports', '데이터 관리', 'member.write', 'document.write', 'transaction.write'],
  ['reservations', '예약', 'reservation.create', 'reservation.manage'],
  ['organization', '조직 설정', 'organization.settings'], ['roles', '역할과 권한', 'role.assign'],
  ['api_keys', 'API 설정', 'agent.chat'], ['settings', '설정', 'member.read', 'role.assign', 'agent.chat'],
].map(([key, label, ...actions]) => ({ code: `menu.${key}`, label, actions }));

export function compatibleMenus(permissions) {
  const values = new Set(permissions);
  return MENU_CATALOG.filter(menu => values.has('*') || menu.actions.some(action => values.has(action))).map(menu => menu.code);
}

// 기존 역할은 기존 동작 권한에 대응하는 메뉴를 유지한다. 커스텀 역할에는 자동 메뉴를 더하지 않는다.
export function effectivePgPermissions(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const codes = grouped.get(row.role) ?? [];
    if (row.code && row.code !== '*' && !row.code.startsWith('platform.')) codes.push(row.code);
    grouped.set(row.role, codes);
  }
  return [...new Set([...grouped.values()].flatMap(codes => codes.includes('menu.configured')
    ? codes.filter(code => code !== 'menu.configured') : [...codes, ...compatibleMenus(codes)]))].sort();
}

export function menuForApi(req) {
  const path = (req.originalUrl ?? '').split('?')[0].replace(/^\/api\/v1\/(pg\/)?/, '/');
  if (/^\/settings\/(roles|members)(\/|$)/.test(path)) return 'menu.roles';
  if (/^\/org\/modules|^\/members\/home-layout|^\/members\/departments\/[^/]+\/access/.test(path)) return 'menu.organization';
  if (/^\/tenants\/current/.test(path)) return req.method === 'GET' ? null : 'menu.organization';
  if (/^\/members|^\/(departments|positions)\/options/.test(path)) return 'menu.members';
  if (/^\/projects|^\/tasks|^\/records\/(projects|tasks)\//.test(path)) return 'menu.projects';
  if (/^\/calendar|^\/records\/calendar\//.test(path)) return 'menu.calendar';
  if (/^\/hr\/attendance/.test(path)) return 'menu.attendance';
  if (/^\/hr\/leave/.test(path)) return 'menu.leave';
  if (/^\/hr\/(postings|applications|onboarding)/.test(path)) return 'menu.recruitment';
  if (/^\/approvals|^\/records\/approvals\//.test(path)) return 'menu.approvals';
  if (/^\/finance|^\/records\/(transactions|budgets|dues|settlements)\//.test(path)) return 'menu.finance';
  if (/^\/assets|^\/records\/assets\//.test(path)) return 'menu.assets';
  if (/^\/documents\/graph/.test(path)) return 'menu.knowledge';
  if (/^\/documents|^\/records\/documents\//.test(path)) return 'menu.documents';
  if ((req.originalUrl ?? '').startsWith('/api/v1/pg/vault/')) return null; // 개인 PG 노트는 회사 역할과 독립된 소유자 권한이다.
  if (/^\/vault\/graph/.test(path)) return 'menu.vault_graph';
  if (/^\/vault/.test(path)) return 'menu.vault';
  if (/^\/agent\/api-key/.test(path)) return null; // 개인 비밀키는 회사 역할의 관리 대상이 아니다.
  if (/^\/agent/.test(path)) return 'menu.agent';
  if (/^\/analytics/.test(path)) return 'menu.analytics';
  if (/^\/notifications/.test(path)) return 'menu.notifications';
  if (/^\/handovers/.test(path)) return 'menu.handover';
  if (/^\/automations?/.test(path)) return 'menu.automations';
  if (/^\/integrations/.test(path)) return 'menu.integrations';
  if (/^\/imports/.test(path)) return 'menu.imports';
  return null;
}
