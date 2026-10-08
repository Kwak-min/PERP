import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';
import { api, startTestServer } from '../../backend/tests/http.js';
import { startDailyNativePostgres } from '../../backend/tests/daily-native-fixture.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.resolve(root, '../.omo/evidence/invitation-clipboard', process.env.DEADLINE_RUN_ID ?? 'local');
await mkdir(evidence, { recursive: true });
const password = 'password-1234', results = [];
let native, server, vite, browser, origin;
const routePath = response => new URL(response.url()).pathname;
async function request(actor, route, method = 'GET', body, status = 200) {
  const response = await api(server.baseUrl, route, { ...actor, method, body });
  assert.equal(response.status, status, `${route}: ${JSON.stringify(response.body)}`); return response.body;
}
async function login(page, email, invitation = null) {
  await page.goto(origin + '/login' + (invitation ? '?invite=' + encodeURIComponent(invitation) : ''));
  await page.getByLabel('이메일', { exact: true }).fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(password);
  await Promise.all([page.waitForURL(origin + (invitation ? '/invitations' : '/')), page.getByRole('button', { name: '로그인', exact: true }).click()]);
}
async function screenshot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled' });
}
try {
  native = await startDailyNativePostgres();
  await native.pool.query(await readFile(new URL('../../db/perp_additions_v8.sql', import.meta.url), 'utf8'));
  server = await startTestServer();
  vite = await preview({ configFile: false, root, envDir: path.join(evidence, 'no-env'), preview: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(server.baseUrl).origin } } });
  origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome' });
  for (const storage of ['pg', 'sqlite']) for (const mode of ['signup', 'login', 'switch-login', 'switch-signup']) {
    const width = ['signup', 'switch-login'].includes(mode) ? 375 : 1280;
    const name = `${storage}-${mode}-${width}`, email = `receiver-${name}@example.invalid`, senderEmail = `sender-${name}@example.invalid`;
    const pg = storage === 'pg', auth = pg ? '/pg/auth' : '/auth', base = pg ? '/pg' : '';
    const signup = await request(null, `${auth}/signup`, 'POST', { email: senderEmail, name: `Sender ${name}`, password }, 201);
    const sender = { token: pg ? signup.token : signup.access_token };
    const company = await request(sender, pg ? '/pg/companies' : '/tenants', 'POST', { name: `Shared ${name}`, ...(!pg ? { type: 'company' } : {}), modules: ['projects', 'tasks'], features: [], departments: [] }, 201); sender.orgId = company.org_id;
    const role = await request(sender, '/settings/roles', 'POST', { name: 'Shared reader', scope: 'all', permissions: ['menu.home', 'menu.projects', 'menu.members', 'member.read', 'project.read', 'task.read'] }, 201);
    const project = await request(sender, `${base}/projects`, 'POST', { name: `Initial ${name}` }, 201);
    const oppositeAuth = pg ? '/auth' : '/pg/auth';
    const duplicate = await request(null, `${oppositeAuth}/signup`, 'POST', { email, name: 'Separate account', password }, 201);
    const duplicateActor = { token: duplicate.token ?? duplicate.access_token };
    const otherCompany = await request(duplicateActor, pg ? '/tenants' : '/pg/companies', 'POST', { name: `Opposite ${name}`, ...(pg ? { type: 'company' } : {}), modules: ['projects'], features: [], departments: [] }, 201);
    duplicateActor.orgId = otherCompany.org_id;
    const originalOppositeWorkspace = await request(duplicateActor, `${oppositeAuth}${pg ? '/me' : '/workspace'}`);
    let existing, priorCompany, priorProject;
    if (mode.endsWith('login')) {
      existing = await request(null, `${auth}/signup`, 'POST', { email, name: `Existing ${name}`, password }, 201);
      const actor = { token: existing.token ?? existing.access_token };
      priorCompany = await request(actor, pg ? '/pg/companies' : '/tenants', 'POST', { name: `Prior ${name}`, ...(!pg ? { type: 'company' } : {}), modules: ['projects'], features: [], departments: [] }, 201);
      actor.orgId = priorCompany.org_id;
      priorProject = await request(actor, `${base}/projects`, 'POST', { name: `Prior private ${name}` }, 201);
    }
    const contexts = [], errors = [], traffic = [], clipboardChecks = [];
    const clipboardUnavailable = mode.endsWith('signup');
    async function pageFor() {
      const context = await browser.newContext({ viewport: { width, height: 900 }, permissions: clipboardUnavailable ? [] : ['clipboard-read', 'clipboard-write'] }); contexts.push(context);
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', req => { const url = new URL(req.url()); if (url.pathname.startsWith('/api/')) traffic.push({ method: req.method(), path: url.pathname }); });
      return page;
    }
    const senderPage = await pageFor(), receiverPage = await pageFor();
    try {
      await login(senderPage, senderEmail);
      await senderPage.goto(origin + '/members');
      const [options] = await Promise.all([senderPage.waitForResponse(r => routePath(r) === `/api/v1${base}/members/invites/options`),
        senderPage.getByRole('button', { name: '구성원 추가', exact: true }).click()]);
      assert.equal(options.status(), 200);
      await senderPage.getByLabel('초대받을 이메일', { exact: true }).fill(email);
      await senderPage.getByRole('checkbox', { name: 'Shared reader', exact: true }).check();
      const [createdResponse] = await Promise.all([senderPage.waitForResponse(r => routePath(r) === `/api/v1${base}/members/invites` && r.request().method() === 'POST'), senderPage.getByRole('button', { name: '7일 초대 코드 만들기', exact: true }).click()]);
      assert.equal(createdResponse.status(), 201); const created = await createdResponse.json();
      assert.equal(created.delivery, 'manual');
      if (clipboardUnavailable) {
        // HTTP와 동일한 API 부재만 재현한다. 실제 execCommand/OS 클립보드는 대체하지 않는다.
        await senderPage.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
        assert.equal(await senderPage.evaluate(() => typeof navigator.clipboard), 'undefined');
      }
      await receiverPage.goto(origin + '/invitations');
      const pasteTarget = receiverPage.getByLabel('초대 링크 또는 토큰', { exact: true });
      async function pasteClipboard(expected) {
        await receiverPage.bringToFront();
        await pasteTarget.fill('');
        await pasteTarget.focus();
        // 키 입력 전에 정확한 paste 이벤트를 구독한다. 고정 지연/폴링 없이 실제 붙여넣기를 확인한다.
        await pasteTarget.evaluate(input => {
          window.invitationPaste = null;
          input.addEventListener('paste', event => { window.invitationPaste = event.clipboardData.getData('text/plain'); }, { once: true });
        });
        await receiverPage.keyboard.press('Control+V');
        assert.equal(await receiverPage.evaluate(() => window.invitationPaste), expected);
        assert.equal(await pasteTarget.inputValue(), expected);
      }
      const code = created.token, link = `${origin}/invitations?invite=${encodeURIComponent(code)}`;
      for (const [buttonName, fieldName, expected] of [['코드 복사', '초대 코드', code], ['링크 복사', '초대 링크', link]]) {
        await senderPage.bringToFront();
        const field = senderPage.getByLabel(fieldName, { exact: true });
        await field.evaluate(input => input.setSelectionRange(2, 6));
        const button = senderPage.getByRole('button', { name: buttonName, exact: true });
        await button.click();
        await expect(senderPage.locator('.invitation-sharing [role=status]')).toBeVisible();
        assert.equal(await button.evaluate(element => document.activeElement === element), true, 'copy preserves trigger focus');
        assert.deepEqual(await field.evaluate(input => [input.selectionStart, input.selectionEnd]), [2, 6], 'copy preserves manual selection');
        await pasteClipboard(expected);
        clipboardChecks.push({ field: fieldName, apiUnavailable: clipboardUnavailable, realPaste: true, focusPreserved: true, selectionPreserved: true });
      }
      if (clipboardUnavailable) {
        for (const failure of ['false', 'throw']) {
          await senderPage.evaluate(failure => {
            window.originalExecCommand = document.execCommand;
            document.execCommand = () => { if (failure === 'throw') throw new DOMException('Copy blocked', 'NotAllowedError'); return false; };
          }, failure);
          const button = senderPage.getByRole('button', { name: '링크 복사', exact: true });
          try {
            await senderPage.bringToFront();
            await button.click();
            await expect(senderPage.locator('.invitation-sharing [role=alert]')).toBeVisible();
            assert.equal(await senderPage.locator('.invitation-sharing [role=status]').count(), 0, 'failed copy never reports success');
            assert.equal(await button.evaluate(element => document.activeElement === element), true, 'failure restores focus');
            await pasteClipboard(link); // 실패는 앞선 실제 복사 값을 변경하지 않는다.
          } finally { await senderPage.evaluate(() => { document.execCommand = window.originalExecCommand; delete window.originalExecCommand; }); }
          clipboardChecks.push({ failure, errorShown: true, successShown: false, focusPreserved: true });
        }
        // 실패 뒤에도 읽기 전용 입력의 직접 선택/복사/붙여넣기가 가능하다.
        const field = senderPage.getByLabel('초대 코드', { exact: true });
        await senderPage.bringToFront();
        await field.focus();
        assert.deepEqual(await field.evaluate(input => [input.selectionStart, input.selectionEnd]), [0, code.length]);
        await senderPage.keyboard.press('Control+C');
        await pasteClipboard(code);
        await senderPage.bringToFront();
        await senderPage.getByRole('button', { name: '링크 복사', exact: true }).click();
        await expect(senderPage.locator('.invitation-sharing [role=status]')).toBeVisible();
        await pasteClipboard(link);
      }
      await screenshot(senderPage, `${name}-sender-share`);
      if (mode.startsWith('switch-')) {
        // 반대 저장소의 동일 이메일 계정으로 실제 로그인한 상태에서 링크를 연다.
        const oppositeHint = pg ? 'A'.repeat(43) : '11111111-1111-4111-8111-111111111111';
        await login(receiverPage, email, oppositeHint);
      }
      await receiverPage.goto(width === 375 ? origin + '/invitations' : link + '&next=' + encodeURIComponent('/\\evil.invalid'));
      if (width === 375) await receiverPage.getByLabel('초대 링크 또는 토큰', { exact: true }).fill(code);
      if (mode.startsWith('switch-')) {
        await expect(receiverPage.locator('[data-invitation-store-mismatch]')).toBeVisible();
        assert.equal(await receiverPage.getByRole('button', { name: '초대 확인', exact: true }).count(), 0);
        await screenshot(receiverPage, `${name}-store-mismatch`);
      }
      const creating = mode.endsWith('signup');
      await receiverPage.getByRole('button', { name: creating ? '계정 만들고 참여' : '로그인하고 참여', exact: true }).click();
      if (creating) await receiverPage.getByLabel('이름', { exact: true }).fill(`Receiver ${name}`);
      await receiverPage.getByLabel('이메일', { exact: true }).fill(email);
      await receiverPage.getByLabel('비밀번호', { exact: true }).fill(password);
      if (creating) {
        await receiverPage.getByLabel('비밀번호 확인', { exact: true }).fill(password);
        await receiverPage.getByRole('checkbox').check();
      }
      const [authenticated] = await Promise.all([receiverPage.waitForResponse(r => routePath(r) === `/api/v1${auth}/${creating ? 'signup' : 'login'}`),
        receiverPage.waitForURL(origin + '/invitations'), receiverPage.getByRole('button', { name: creating ? '계정 만들기' : '로그인', exact: true }).click()]);
      assert.equal(authenticated.status(), creating ? 201 : 200);
      const authenticatedBody = await authenticated.json();
      if (existing) assert.equal(authenticatedBody.user.id, existing.user.id);
      const beforeJoin = await request({ token: authenticatedBody.token ?? authenticatedBody.access_token }, `${auth}${pg ? '/workspace' : '/me'}`);
      assert.equal(beforeJoin.organizations.some(org => org.org_id === sender.orgId), false);
      assert.equal(await receiverPage.evaluate(() => sessionStorage.getItem('orbitflow.auth.invite.v1')), code);
      const [verified] = await Promise.all([receiverPage.waitForResponse(r => routePath(r) === `/api/v1${auth}/invitations/verify`), receiverPage.getByRole('button', { name: '초대 확인', exact: true }).click()]);
      assert.equal((await verified.json()).valid, true);
      await screenshot(receiverPage, `${name}-receiver-verify`);
      const [accepted] = await Promise.all([receiverPage.waitForResponse(r => routePath(r) === `/api/v1${auth}/invitations/accept`), receiverPage.waitForURL(origin + '/'), receiverPage.getByRole('button', { name: `Shared ${name} 참여하기`, exact: true }).click()]);
      assert.equal(accepted.status(), 201); assert.equal((await accepted.json()).org_id, sender.orgId);
      const receiverSession = await receiverPage.evaluate(() => JSON.parse(sessionStorage.getItem('orbitflow.session.v1') ?? localStorage.getItem('orbitflow.session.v1')));
      assert.equal(receiverSession.orgId, sender.orgId);
      assert.equal(await receiverPage.evaluate(() => sessionStorage.getItem('orbitflow.auth.invite.v1')), null);
      assert.equal(await receiverPage.evaluate(code => Object.values(localStorage).some(value => value.includes(code)), code), false);
      await receiverPage.goto(origin + '/projects');
      await expect(receiverPage.getByRole('button', { name: `Initial ${name}`, exact: true })).toBeVisible();
      assert.equal((await request({ token: receiverSession.token }, `${auth}${pg ? '/workspace' : '/me'}`)).organizations.some(org => org.org_id === sender.orgId), true);
      const projectId = project.id;
      for (const [mode, version] of [['refresh', 1], ['focus', 2], ['reload', 3]]) {
        await request(sender, `${base}/projects/${projectId}`, 'PATCH', { version, name: `${mode} ${name}` });
        await Promise.all([receiverPage.waitForResponse(r => routePath(r) === `/api/v1${base}/projects` && r.status() === 200),
          mode === 'refresh' ? receiverPage.getByRole('button', { name: '새로고침', exact: true }).click()
            : mode === 'focus' ? receiverPage.evaluate(() => window.dispatchEvent(new Event('focus'))) : receiverPage.reload()]);
        await expect(receiverPage.getByRole('button', { name: `${mode} ${name}`, exact: true })).toBeVisible();
      }
      await screenshot(receiverPage, `${name}-shared-fresh`);
      // 초대 링크를 통한 재로그인도 중복 이메일의 다른 저장소로 이동하지 않는다.
      await login(receiverPage, email, code);
      const [replayed] = await Promise.all([receiverPage.waitForResponse(r => routePath(r) === `/api/v1${auth}/invitations/verify`), receiverPage.getByRole('button', { name: '초대 확인', exact: true }).click()]);
      assert.equal((await replayed.json()).reason, 'accepted');
      await Promise.all([receiverPage.waitForURL(origin + '/'), receiverPage.getByRole('button', { name: `Shared ${name} 참여하기`, exact: true }).click()]);
      await receiverPage.goto(origin + '/projects');
      await expect(receiverPage.getByRole('button', { name: `reload ${name}`, exact: true })).toBeVisible();
      const oppositeWorkspace = await request(duplicateActor, `${oppositeAuth}${pg ? '/me' : '/workspace'}`);
      assert.deepEqual(oppositeWorkspace.organizations, originalOppositeWorkspace.organizations);
      const finalWorkspace = await request({ token: receiverSession.token }, `${auth}${pg ? '/workspace' : '/me'}`);
      assert.equal(finalWorkspace.organizations.length, priorCompany ? 2 : 1);
      if (priorCompany) {
        assert.ok(finalWorkspace.organizations.some(org => org.org_id === priorCompany.org_id));
        const previous = await request({ token: receiverSession.token, orgId: priorCompany.org_id }, `${base}/projects`);
        assert.ok(previous.items.some(row => (pg ? row.__id : row.id) === priorProject.id));
        assert.equal((await api(server.baseUrl, `${base}/projects`, { ...sender, orgId: priorCompany.org_id })).status, 403);
      }
      assert.deepEqual(errors, []);
      results.push({ name, result: 'PASS', codeCopied: true, linkCopied: true, clipboardChecks, signup: creating, duplicateEmailIsolated: true, priorMembershipPreserved: Boolean(priorCompany), accepted: true, sharedReads: ['refresh', 'focus', 'reload', 'relogin', 'workspace'], role: role.key, traffic });
      console.log(`INVITATION_SHARING_PASS ${name}`);
    } catch (error) {
      await screenshot(senderPage, `${name}-sender-failure`);
      await screenshot(receiverPage, `${name}-failure`);
      results.push({ name, result: 'FAIL', error: String(error), traffic }); throw error;
    } finally { for (const context of contexts) await context.close(); }
  }
} finally {
  await browser?.close();
  if (vite) await new Promise((resolve, reject) => vite.httpServer.close(error => error ? reject(error) : resolve()));
  await server?.close();
  const { closePgPool } = await import('../../backend/src/config/pg.js'); await closePgPool();
  await native?.close();
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ results, cleanupDoneClaim: true, operatingServicesUsed: false }, null, 2));
  console.log('INVITATION_OWNED_RESOURCES_CLOSED');
}
