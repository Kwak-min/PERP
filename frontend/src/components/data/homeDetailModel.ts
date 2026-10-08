import { z } from 'zod';
import type { WorkspaceAccess } from '../../hooks/useWorkspaceAccess';
import { isPgWorkspace } from '../../services/workspace';
import { membersSchema } from './MemberListModal';
import { parseProjects, parseTasks, statusLabel } from '../../screens/projects/model';

export const homeCategories = [
  { key: 'members', label: '구성원', permission: 'member.read', menu: 'menu.members', module: null },
  { key: 'projects', label: '프로젝트', permission: 'project.read', menu: 'menu.projects', module: 'projects' },
  { key: 'tasks', label: '업무', permission: 'task.read', menu: 'menu.projects', module: 'tasks' },
  { key: 'documents', label: '문서', permission: 'document.read', menu: 'menu.documents', module: 'documents' },
] as const;
export type HomeCategory = typeof homeCategories[number]['key'];
export type HomeSelection = HomeCategory | 'overview';
export type HomeRow = Readonly<{ id: string; name: string; facts: readonly (readonly [string, string])[]; href?: string }>;
export const homeUsageSchema = z.object({ members: z.number().nonnegative(), projects: z.number().nonnegative(), tasks: z.number().nonnegative(), documents: z.number().nonnegative() });
const id = z.union([z.string().min(1), z.number().int().safe()]).transform(String);
const documentListSchema = z.object({ items: z.array(z.object({ id, title: z.string(), review_status: z.string().optional(), version: z.number().optional(), updated_at: z.string().optional() })) });
const pgDocumentListSchema = z.object({ items: z.array(z.object({ __id: id, 제목: z.string(), 프로젝트: z.string().nullable(), 버전: z.number(), 수정일: z.string() })) });
export const homeDocumentSchema = z.object({ id, title: z.string(), content: z.string(), version: z.number() });
const shown = (value: string | number | null | undefined) => value == null || value === '' ? '미지정' : String(value);
const status = (value: string) => ({ active: '활성', inactive: '휴면', left: '탈퇴', archived: '보관' }[value] ?? statusLabel(value));

export function homeCategoryAllowed(access: WorkspaceAccess, category: HomeCategory): boolean {
  const config = homeCategories.find(item => item.key === category)!;
  const all = access.permissions.includes('*');
  return (all || access.permissions.includes(config.permission)) && (all || access.menus.includes(config.menu))
    && (!config.module || access.modules.includes(config.module));
}

// SQLite 목록은 LIMIT -1을 지원하며 PG의 네 목록은 LIMIT 없는 계약이다. 홈은 부서 브랜치가 아닌 현재 회사 범위다.
export function homeListEndpoint(category: HomeCategory, orgId: string | null): string {
  return `/pg/${category}${isPgWorkspace(orgId) ? '' : '?limit=-1'}`;
}

export function parseHomeRows(payload: unknown, category: HomeCategory, pg: boolean): HomeRow[] {
  if (category === 'members') return membersSchema.parse(payload).items.map(member => {
    // membership_id는 할당 변경용이다. 사용자 상세 식별자는 user_id만 사용한다.
    const userId = z.string().min(1).parse(member.user_id);
    return { id: userId, name: member.name, facts: [['이메일', member.email], ['직책', shown(member.title)], ['역할', member.roles.join(' · ') || '미지정'], ['상태', status(member.status)]] };
  });
  if (category === 'projects') return parseProjects(payload, pg).map(project => ({ id: project.id, name: project.name, href: `/projects/${encodeURIComponent(project.id)}`,
    facts: [['상태', status(project.status)], ['시작', shown(project.start_date)], ['종료', shown(project.end_date)], ['설명', shown(project.description)]] }));
  if (category === 'tasks') return parseTasks(payload, pg).map(task => ({ id: task.id, name: task.title, href: `/tasks/${encodeURIComponent(task.id)}`,
    facts: [['상태', status(task.status)], ['기한', shown(task.due_at)], ...(task.project_name ? [['프로젝트', task.project_name] as const] : []), ...(task.assignee_name ? [['담당자', task.assignee_name] as const] : []), ['설명', shown(task.description)]] }));
  if (pg) return pgDocumentListSchema.parse(payload).items.map(document => ({ id: document.__id, name: document.제목,
    facts: [['프로젝트', shown(document.프로젝트)], ['버전', String(document.버전)], ['수정일', document.수정일]] }));
  return documentListSchema.parse(payload).items.map(document => ({ id: document.id, name: document.title,
    facts: [['검토 상태', shown(document.review_status)], ['버전', shown(document.version)], ['수정일', shown(document.updated_at)]] }));
}
