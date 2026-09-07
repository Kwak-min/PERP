import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { api, createOwnerOrg, startTestServer } from '../../backend/tests/http.js';
import { installProjectTaskFixture } from '../../backend/tests/project-task-fixture.js';

// 실제 Chrome/SPA/Express/임시 SQLite. PG 도메인 SQL만 격리 SQL 경계에서 실행한다.
process.env.DATABASE_URL = ''; process.env.PG_HOST = '127.0.0.1'; process.env.PG_PORT = '1';
const frontend = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(frontend, '.artifacts/project-task-unification');
await mkdir(evidence, { recursive: true });
const server = await startTestServer();
const fixture = await installProjectTaskFixture();
let vite, browser;
const results = [];
// 리드가 소유한 registry 파일은 수정하지 않는다. 어댑터 모드는 화면 계약만 검증하며
// 기본 실행은 반드시 운영 registry를 사용하므로 등록 누락을 숨기지 않는다.
const screenOnly = process.env.PROJECT_TASK_SCREEN_ONLY === '1';
const registryAdapter = { name: 'project-task-screen-contract', enforce: 'pre', transform(code, id) {
  if (!screenOnly || !id.replaceAll('\\', '/').endsWith('/src/screens/registry.ts')) return;
  return code + `\nimport { ProjectTaskScreen as ScreenContract } from './ProjectTaskScreen';\nObject.assign(screenOverrides, { 'PRJ-001': ScreenContract, 'PRJ-002': ScreenContract, 'TSK-001': ScreenContract, 'TSK-003': ScreenContract });`;
} };
console.log('REGISTRY_MODE ' + (screenOnly ? 'TEST_ADAPTER_NOT_PRODUCTION_INTEGRATION' : 'PRODUCTION'));
try {
  vite = await createServer({ configFile: false, root: frontend, plugins: [registryAdapter, react()], server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.artifacts/**', '**/dist/**'] }, proxy: { '/api': new URL(server.baseUrl).origin } } });
  await vite.listen(); const origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
  browser = await chromium.launch({ channel: 'chrome' }); console.log('CHROME_VERSION ' + browser.version());
  const owner = await createOwnerOrg(server.baseUrl, ['projects', 'tasks']);
  const other = await createOwnerOrg(server.baseUrl, ['projects', 'tasks']);
  const login = await api(server.baseUrl, '/pg/auth/login', { method: 'POST', body: { email: fixture.identity.users[0].email, password: 'password-1234' } });
  assert.equal(login.status, 200);
  for (const session of [{ ...owner, pg: false, name: 'legacy' }, { token: login.body.token, orgId: 'pg:77', pg: true, name: 'pg-sql-boundary' }]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // 원격 폰트/CDN 포함 외부 네트워크는 테스트에서 차단한다.
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await context.addInitScript(stored => localStorage.setItem('orbitflow.session.v1', JSON.stringify(stored)), { token: session.token, orgId: session.orgId, name: 'Project QA', email: 'project@example.invalid', mustChangePassword: false, organizations: [{ org_id: session.orgId, org_name: 'PROJECT_QA', org_type: session.pg ? 'perp_db' : 'custom', roles: ['member'] }] });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const prefix = session.pg ? '/pg' : '';
    const responseFor = (resource, method = 'GET') => page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${prefix}/${resource}` && response.request().method() === method);
    const row = id => page.locator(`.project-tasks__project[data-project-id="${id}"]`);
    const shot = name => page.screenshot({ path: path.join(evidence, `${session.name}-${name}.png`), fullPage: true });
    const createProject = async (name, credentials = session) => {
      const created = await api(server.baseUrl, `${prefix}/projects`, { ...credentials, method: 'POST', body: { name } }); assert.equal(created.status, 201); return String(created.body.id);
    };
    const createTask = async (id, title, status = 'todo') => {
      const created = await api(server.baseUrl, `${prefix}/tasks`, { ...session, method: 'POST', body: { project_id: id, title } }); assert.equal(created.status, 201);
      const taskId = String(created.body.id);
      if (status !== 'todo') assert.equal((await api(server.baseUrl, session.pg ? `/pg/records/tasks/${taskId}` : `/tasks/${taskId}`, { ...session, method: 'PATCH', body: { status } })).status, 200);
      return taskId;
    };
    try {
      const loaded = responseFor('projects'); await page.goto(origin + '/projects'); assert.equal((await loaded).status(), 200);
      await expect(page.locator('.project-tasks')).toBeVisible();
      assert.equal(await page.locator('.project-tasks__project').count(), 0); await shot('empty');
      await expect(page.getByRole('button', { name: '프로젝트 만들기', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '프로젝트 만들기', exact: true }).click();
      await page.getByLabel('이름', { exact: true }).fill('동일 이름');
      const projectSaved = responseFor('projects', 'POST');
      await page.getByRole('dialog').getByRole('button', { name: '만들기', exact: true }).click();
      const created = await projectSaved; assert.equal(created.status(), 201); const a = String((await created.json()).id);
      await expect(row(a)).toBeVisible(); await expect(row(a).getByRole('progressbar')).toHaveAttribute('value', '0');
      await expect(row(a).locator('.project-tasks__expand')).toHaveAttribute('aria-expanded', 'false');
      await row(a).locator('.project-tasks__expand').focus(); await page.keyboard.press('Enter');
      await expect(row(a).locator('.project-tasks__expand')).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Space'); await expect(row(a).locator('.project-tasks__expand')).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('Enter');
      await row(a).getByRole('button', { name: '업무 만들기', exact: true }).click();
      await expect(page.getByRole('combobox', { name: '프로젝트', exact: true })).toHaveValue(a);
      await expect(page.getByRole('combobox', { name: '프로젝트', exact: true })).toBeDisabled();
      await page.getByLabel('제목', { exact: true }).fill('브라우저 업무');
      const taskSaved = responseFor('tasks', 'POST');
      await page.getByRole('dialog').getByRole('button', { name: '만들기', exact: true }).click();
      const saved = await taskSaved; assert.equal(saved.status(), 201); const taskId = String((await saved.json()).id);
      assert.equal(saved.request().postDataJSON().project_id, a);
      await expect(row(a).getByRole('link', { name: '브라우저 업무', exact: true })).toBeVisible();
      const b = await createProject('동일 이름'), empty = await createProject('업무 없는 프로젝트');
      await createTask(a, '이미 완료 업무', 'done'); await createTask(b, '다른 프로젝트 업무');
      if (session.pg) fixture.task(fixture.project('외부 프로젝트', '88'), 'OTHER_ORG_SECRET', 'done');
      else {
        const foreign = await createProject('외부 프로젝트', other);
        assert.equal((await api(server.baseUrl, '/tasks', { ...other, method: 'POST', body: { project_id: foreign, title: 'OTHER_ORG_SECRET' } })).status, 201);
      }
      let reload = responseFor('tasks'); await page.reload(); assert.equal((await reload).status(), 200);
      await expect(row(a).getByRole('progressbar')).toHaveAttribute('value', '50');
      await expect(row(b).getByRole('progressbar')).toHaveAttribute('value', '0');
      await expect(row(empty).getByRole('progressbar')).toHaveAttribute('value', '0');
      await row(a).locator('.project-tasks__expand').click();
      assert.equal(await row(a).getByRole('link', { name: '다른 프로젝트 업무', exact: true }).count(), 0);
      assert.equal(await page.getByRole('link', { name: 'OTHER_ORG_SECRET', exact: true }).count(), 0);
      const updatePath = session.pg ? `records/tasks/${taskId}` : `tasks/${taskId}`;
      const updated = responseFor(updatePath, 'PATCH');
      await row(a).getByLabel('브라우저 업무 상태', { exact: true }).selectOption('done'); assert.equal((await updated).status(), 200);
      await expect(row(a).locator('.project-tasks__progress progress')).toHaveAttribute('value', '100');
      await shot('expanded-completed');
      await row(a).getByRole('link', { name: '브라우저 업무', exact: true }).click();
      await expect(page).toHaveURL(origin + `/tasks/${taskId}`);
      await expect(page.locator('.project-tasks__detail')).toBeVisible();
      await page.reload(); await expect(page.getByRole('combobox', { name: '상태', exact: true })).toHaveValue('done');
      await expect(page.getByLabel('제목', { exact: true })).toBeEnabled();
      await page.getByLabel('제목', { exact: true }).fill('수정된 브라우저 업무');
      await page.getByRole('combobox', { name: '상태', exact: true }).selectOption('todo');
      const detailSave = responseFor(updatePath, 'PATCH'); await page.getByRole('button', { name: '변경 저장', exact: true }).click(); assert.equal((await detailSave).status(), 200);
      await expect(page.getByRole('heading', { name: '수정된 브라우저 업무', exact: true })).toBeVisible();
      await page.locator('.project-tasks__detail').getByRole('link').click();
      await expect(row(a).locator('.project-tasks__expand')).toHaveAttribute('aria-expanded', 'true');
      await expect(row(a).locator('.project-tasks__progress progress')).toHaveAttribute('value', '50');
      await page.reload(); await expect(row(a).locator('.project-tasks__progress progress')).toHaveAttribute('value', '50');
      await expect(row(a).getByRole('link', { name: '수정된 브라우저 업무', exact: true })).toBeVisible();
      if (!session.pg) assert.equal((await api(server.baseUrl, '/tasks', { ...session, method: 'POST', body: { title: '미배정 업무', project_id: null } })).status, 201);
      await page.getByRole('link', { name: '전체 업무', exact: true }).click();
      await expect(page).toHaveURL(origin + '/tasks');
      if (!session.pg) await expect(page.getByRole('link', { name: '미배정 업무', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: '다른 프로젝트 업무', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: '수정된 브라우저 업무', exact: true })).toBeVisible();
      await page.getByRole('link', { name: '프로젝트로', exact: true }).click();
      await expect(row(a)).toBeVisible(); await row(a).locator('.project-tasks__expand').click();
      await page.setViewportSize({ width: 375, height: 900 });
      // 활성 CSS 전환 완료 이벤트만 기다린다. 고정 지연을 쓰지 않는다.
      await page.evaluate(async () => { document.body.getBoundingClientRect(); let timer; try { await Promise.race([Promise.all(document.getAnimations().map(animation => animation.finished)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('animation timeout')), 5000); })]); } finally { clearTimeout(timer); } });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await shot('mobile');
      const bottomControl = row(a).locator('.project-tasks__task-state select').last();
      // 고정 하단 메뉴는 viewport 내부이므로 ifNeeded 판정 대신 실제 스크롤을 수행한다.
      await bottomControl.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      assert.equal(await bottomControl.evaluate(element => { const bounds = element.getBoundingClientRect(); return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2) === element; }), true, 'bottom task controls remain reachable above mobile navigation');
      await page.setViewportSize({ width: 1280, height: 900 });
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const taskUrl = url => url.pathname === `/api/v1${prefix}/tasks`;
      await page.route(taskUrl, async route => { await gate; await route.continue(); });
      try {
        const requested = page.waitForRequest(request => taskUrl(new URL(request.url())));
        await page.reload(); await requested; await expect(row(a)).toBeVisible();
        assert.equal(await row(a).getByRole('progressbar').count(), 0);
        await row(a).locator('.project-tasks__expand').click();
        await expect(row(a).locator('.state-card[role="status"]')).toBeVisible();
        await shot('loading');
        const resumed = responseFor('tasks'); release(); await resumed;
        await expect(row(a).locator('.project-tasks__progress progress')).toHaveAttribute('value', '50');
      } finally { release(); await page.unroute(taskUrl); }
      results.push(`${session.name}: empty/loading, actual create, keyboard expand, project/company isolation, done/total, inline update, detail update/reload, all-task links, mobile`);
      if (session.pg) {
        const grants = fixture.identity.state.permissions;
        fixture.identity.state.permissions = grants.filter(grant => grant.code !== 'task.write');
        await page.reload(); await expect(row(a)).toBeVisible(); await row(a).locator('.project-tasks__expand').click();
        await expect(row(a).getByLabel('수정된 브라우저 업무 상태', { exact: true })).toBeDisabled();
        fixture.identity.state.permissions = grants.filter(grant => grant.code !== 'task.read');
        reload = responseFor('tasks'); await page.reload(); assert.equal((await reload).status(), 403);
        await expect(row(a)).toBeVisible(); assert.equal(await row(a).getByRole('progressbar').count(), 0);
        await row(a).locator('.project-tasks__expand').click(); await expect(row(a).getByRole('alert')).toBeVisible(); await shot('task-forbidden');
        fixture.identity.state.permissions = grants.filter(grant => grant.code !== 'project.read');
        reload = responseFor('projects'); await page.reload(); assert.equal((await reload).status(), 403);
        await expect(page.locator('.project-tasks').getByRole('alert')).toBeVisible();
        assert.equal(await page.locator('.project-tasks__project').count(), 0);
        fixture.identity.state.permissions = grants;
        results.push('pg-sql-boundary: missing write disables controls; task-read denial is not zero progress; project-read denial hides projects');
      }
      assert.deepEqual(errors, []);
    } catch (error) { await shot('failure'); throw error; }
    finally { await context.close(); }
  }
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ chrome: browser.version(), registry: screenOnly ? 'test-only adapter; production integration not verified' : 'production', results, pg: 'SQL boundary fixture; not PostgreSQL runtime', legacy: 'real HTTP + isolated SQLite', remote: false }, null, 2));
  results.forEach(result => console.log('PASS ' + result)); console.log('PROJECT_TASK_UNIFICATION_PASS');
} finally { await browser?.close(); await vite?.close(); await fixture.close(); await server.close(); }
