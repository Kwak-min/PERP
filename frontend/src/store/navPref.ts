import { screens, sectionLabels, type ScreenDefinition, type ScreenSection } from '../routes/catalog';

// userId는 인증 API의 불변 사용자 ID다. 이름/이메일/토큰으로 대체하지 않는다.
export type NavPrefScope = Readonly<{ userId: string; source: 'legacy' | 'pg'; orgId: string }>;
export type NavPref = Readonly<{
  version: 1;
  favoriteScreenIds: readonly string[];
  collapsedSectionIds: readonly ScreenSection[];
}>;
export type NavPrefRead =
  | Readonly<{ status: 'ready' | 'empty' | 'invalid'; value: NavPref }>
  | Readonly<{ status: 'unavailable'; value: NavPref; error: unknown }>;

export const NAV_PREF_NOTICE = '이 브라우저에만 저장됩니다. 다른 기기와 동기화되지 않습니다.';
const knownScreens = new Set(screens.map(screen => screen.id));
const knownSections = new Set<ScreenSection>(Object.keys(sectionLabels) as ScreenSection[]);
const empty = (): NavPref => ({ version: 1, favoriteScreenIds: [], collapsedSectionIds: [] });

export function navPrefKey(scope: NavPrefScope): string {
  if (!scope || typeof scope.userId !== 'string' || !scope.userId.trim()
    || typeof scope.orgId !== 'string' || !scope.orgId.trim()
    || (scope.source !== 'legacy' && scope.source !== 'pg')) {
    throw new TypeError('Authenticated user ID and workspace source/org ID are required');
  }
  // 구분자가 들어간 opaque ID도 충돌하지 않도록 길이가 고정된 JSON tuple을 쓴다.
  return `orbitflow.nav.v1:${JSON.stringify([scope.userId, scope.source, scope.orgId])}`;
}

function isVersionOne(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    && 'version' in input && input.version === 1;
}

function ids<T extends string>(input: unknown, known: ReadonlySet<T>): T[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((id): id is T => typeof id === 'string' && known.has(id as T)))];
}

export function normalizeNavPref(input: unknown): NavPref {
  if (!isVersionOne(input)) return empty();
  return {
    version: 1,
    favoriteScreenIds: ids(input.favoriteScreenIds, knownScreens),
    collapsedSectionIds: ids(input.collapsedSectionIds, knownSections),
  };
}

// 읽기/권한 변경은 저장값을 쓰지 않는다. 손상된 값은 다음 명시적 저장 때 복구한다.
export function readNavPref(scope: NavPrefScope): NavPrefRead {
  const key = navPrefKey(scope);
  let raw: string | null;
  try { raw = localStorage.getItem(key); }
  catch (error) { return { status: 'unavailable', value: empty(), error }; }
  if (raw === null) return { status: 'empty', value: empty() };
  let input: unknown;
  try { input = JSON.parse(raw); }
  catch { return { status: 'invalid', value: empty() }; }
  return { status: isVersionOne(input) ? 'ready' : 'invalid', value: normalizeNavPref(input) };
}

// 오직 버전과 stable ID 배열만 저장한다. 실패는 호출자에게 전달하여 저장 성공 표시를 막는다.
export function writeNavPref(scope: NavPrefScope, input: unknown): NavPref {
  const key = navPrefKey(scope);
  const value = normalizeNavPref(input);
  localStorage.setItem(key, JSON.stringify(value));
  return value;
}

// 매번 최신 값을 읽어 수정한다. scope는 명시적이며 전역 current-user 캐시가 없다.
// localStorage의 다중 탭 동시 쓰기는 last-write-wins이며 서버 동기화/CAS가 아니다.
export function updateNavPref(scope: NavPrefScope, update: (current: NavPref) => unknown): NavPref {
  const current = readNavPref(scope);
  if (current.status === 'unavailable') throw current.error;
  return writeNavPref(scope, update(current.value));
}

// 일반 메뉴와 동일한 최신 권한/module/feature 필터 결과만 전달한다. 저장 목록은 절대 지우지 않는다.
export function selectNavFavorites(value: NavPref, visibleNavigation: readonly Pick<ScreenDefinition, 'id'>[]): readonly ScreenDefinition[] {
  const allowed = new Set(visibleNavigation.map(screen => screen.id));
  const navigable = new Map(screens.filter(screen => screen.nav && allowed.has(screen.id)).map(screen => [screen.id, screen]));
  return normalizeNavPref(value).favoriteScreenIds.flatMap(id => {
    const screen = navigable.get(id);
    return screen ? [screen] : [];
  });
}
