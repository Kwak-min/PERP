import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

test('home payload boundaries preserve server identity, store selection and explicit access', async t => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), envDir: process.env.DEADLINE_TEMP_ROOT, server: { middlewareMode: true, watch: null, hmr: false, ws: false } });
  try {
    const { homeCategories, homeCategoryAllowed, homeListEndpoint, homeUsageSchema, homeDocumentSchema, parseHomeRows } = await vite.ssrLoadModule('/src/components/data/homeDetailModel.ts');
    await t.test('lists use selected store without truncating legacy rows', () => {
      // Given: each supported category and both organization stores.
      for (const category of homeCategories) {
        // When: selecting the list endpoint. Then: legacy asks for all rows; PG retains its native contract.
        assert.equal(homeListEndpoint(category.key, 'legacy-org'), `/pg/${category.key}?limit=-1`);
        assert.equal(homeListEndpoint(category.key, 'pg:12'), `/pg/${category.key}`);
      }
    });
    await t.test('member identity comes from the user rather than membership assignment', () => {
      const member = { membership_id: 'assignment-id', user_id: 'user-id', name: 'MEMBER_SENTINEL', email: 'member@example.invalid', roles: ['reader'], status: 'active', title: 'TITLE_SENTINEL' };
      const rows = parseHomeRows({ items: [member] }, 'members', false);
      assert.equal(rows[0].id, member.user_id); assert.equal(rows[0].name, member.name);
      assert.ok(rows[0].facts.some(([, value]) => value === member.email));
      assert.ok(rows[0].facts.some(([, value]) => value === member.title));
      assert.throws(() => parseHomeRows({ items: [{ ...member, user_id: '' }] }, 'members', false));
    });
    await t.test('project and task details keep distinct original destinations and descriptions', () => {
      const project = { id: 'p/one', name: 'SAME_NAME', status: 'active', description: 'PROJECT_SENTINEL' };
      const task = { id: 't/one', project_id: project.id, title: 'SAME_NAME', status: 'done', description: 'TASK_SENTINEL' };
      const [p] = parseHomeRows({ items: [project] }, 'projects', false);
      const [r] = parseHomeRows({ items: [task] }, 'tasks', false);
      assert.equal(p.href, '/projects/p%2Fone'); assert.equal(r.href, '/tasks/t%2Fone');
      assert.ok(p.facts.some(([, value]) => value === project.description));
      assert.ok(r.facts.some(([, value]) => value === task.description));
    });
    await t.test('native PG rows retain string IDs and supplied relationships', () => {
      const id = '9007199254740993';
      const [project] = parseHomeRows({ items: [{ __id: id, 프로젝트: 'PG_PROJECT', status: 'active', description: 'PG_DESCRIPTION' }] }, 'projects', true);
      const [task] = parseHomeRows({ items: [{ __id: '22', project_id: id, 업무: 'PG_TASK', 프로젝트: 'PG_PROJECT', 담당: 'PG_ASSIGNEE', status: 'todo' }] }, 'tasks', true);
      assert.equal(project.id, id); assert.equal(project.href, `/projects/${id}`);
      assert.ok(task.facts.some(([, value]) => value === 'PG_PROJECT'));
      assert.ok(task.facts.some(([, value]) => value === 'PG_ASSIGNEE'));
    });
    await t.test('document list and body parse both stores and reject malformed payloads', () => {
      const legacy = { id: 'legacy-doc', title: 'LEGACY_DOCUMENT', version: 4 };
      const pg = { __id: '9007199254740993', 제목: 'PG_DOCUMENT', 프로젝트: null, 버전: 7, 수정일: '2026-09-09T00:00:00Z' };
      assert.equal(parseHomeRows({ items: [legacy] }, 'documents', false)[0].id, legacy.id);
      assert.equal(parseHomeRows({ items: [pg] }, 'documents', true)[0].id, pg.__id);
      assert.deepEqual(homeDocumentSchema.parse({ ...legacy, content: 'DOCUMENT_BODY' }), { ...legacy, content: 'DOCUMENT_BODY' });
      assert.throws(() => homeDocumentSchema.parse({ ...legacy, content: null }));
      assert.throws(() => parseHomeRows({ items: [{ ...pg, __id: 9007199254740992 }] }, 'documents', true));
      for (const category of homeCategories) {
        assert.deepEqual(parseHomeRows({ items: [] }, category.key, true), []);
        assert.throws(() => parseHomeRows({ items: [{}] }, category.key, true));
      }
      assert.equal(homeUsageSchema.safeParse({ members: 0, projects: 105, tasks: 1, documents: 2 }).success, true);
      assert.equal(homeUsageSchema.safeParse({ members: -1, projects: 0, tasks: 0, documents: 0 }).success, false);
    });
    await t.test('read grants, menu grants and enabled modules are independent gates', () => {
      for (const category of homeCategories) {
        const access = { org_id: 'org', permissions: [category.permission], menus: [category.menu], modules: category.module ? [category.module] : [], features: [], scope: 'all' };
        assert.equal(homeCategoryAllowed(access, category.key), true);
        assert.equal(homeCategoryAllowed({ ...access, permissions: [] }, category.key), false);
        assert.equal(homeCategoryAllowed({ ...access, menus: [] }, category.key), false);
        if (category.module) assert.equal(homeCategoryAllowed({ ...access, modules: [], permissions: ['*'] }, category.key), false);
      }
    });
  } finally { await vite.close(); }
});
