import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createDeadlineFixture, evidenceBody, startDeadlineServer } from '../../backend/tests/deadline-fixture.js';
import { networkAudit, protectedPorts } from '../../scripts/deadline-isolation-guard.mjs';
import { armDom } from './deadline-role-toggles.e2e.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = path.join(root, '.omo/evidence/task-9-integrated', process.env.DEADLINE_RUN_ID);
const roleFeatures = [
  { key: 'attendance', label: '근태', menu: '/hr/attendance', api: '/hr/attendance' },
  { key: 'leave', label: '휴가', menu: '/hr/leave', api: '/hr/leaves' },
];

function hashRows(database) {
  const state = Object.fromEntries(['attendance', 'leave_balance', 'leave_request'].map(table => [
    table,
    database.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
  ]));
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

export async function disabledHrFeaturesScenario() {
  await mkdir(evidence, { recursive: true });
  const result = {
    scenario: 'disabled-hr-features',
    status: 'running',
    source: 'isolated SQLite / real HTTP API / Google Chrome',
    nativePostgres: 'not exercised and not claimed',
    liveServicesUsed: false,
    resources: [],
    http: [],
    browserResponses: [],
    blockedBrowserRequests: [],
    assertions: {},
    uiSaves: [],
    hashes: {},
    errors: [],
  };
  for (const file of ['frontend/src/screens/RoleSettingsScreen.tsx', 'frontend/src/screens/role-settings-model.ts',
    'frontend/src/screens/role-settings.css', 'frontend/src/screens/OrgModulesScreen.tsx',
    'frontend/scripts/deadline-qa.e2e.mjs', 'frontend/scripts/deadline-disabled-hr-features-qa.mjs']) {
    result.hashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  }
  await writeFile(path.join(evidence, 'scenario.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify({ status: 'pending' }, null, 2));

  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('DEADLINE_CANCELLED'));
  const onMessage = value => { if (value?.type === 'deadline:cancel') cancel(); };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  process.on('message', onMessage);
  let api, vite, browserServer, browser, context, page;
  try {
    api = await startDeadlineServer(controller.signal);
    result.resources.push(api.resource);
    const fixture = await createDeadlineFixture(api);
    const { db } = await import('../../backend/src/config/db.js');
    const admin = fixture.actorAdmin;
    const member = fixture.actorMember;

    await api.request(admin, '/tenants/current', 'PATCH', { features: ['approvals', 'attendance', 'leave'] });
    const role = await api.request(admin, '/settings/roles', 'POST', {
      name: '근태 휴가 보존 검증',
      scope: 'all',
      permissions: ['menu.attendance', 'attendance.read', 'menu.leave', 'leave.approve'],
    }, 201);
    const roleMembers = await api.request(admin, '/settings/members');
    const target = roleMembers.items.find(item => item.membership_id === member.membershipId);
    await api.request(admin, `/settings/members/${member.membershipId}/roles`, 'PUT', {
      roles: [role.key], expected_roles_version: target.roles_version,
    });
    await api.request(admin, '/hr/leave-balances', 'POST', {
      member_id: member.userId, kind: 'annual', granted_days: 12,
    }, 201);
    await api.request(member, '/hr/attendance', 'POST', {
      on_date: '2026-09-08', kind: 'present', hours: 8, source: 'manual', note: '격리 보존 검증',
    }, 201);
    const leave = await api.request(member, '/hr/leaves', 'POST', {
      kind: 'annual', start_on: '2026-09-09', end_on: '2026-09-09', reason: '격리 보존 검증',
    }, 201);
    const dataHashBefore = hashRows(db());
    const rolesBeforeOff = await api.request(admin, '/settings/roles');
    const otherCompanyBefore = await api.request(fixture.B.actor, '/tenants/current');
    await api.request(admin, '/tenants/current', 'PATCH', { features: ['approvals'] });
    assert.equal(hashRows(db()), dataHashBefore, 'turning features off must preserve all stored HR rows');
    assert.deepEqual(await api.request(admin, '/settings/roles'), rolesBeforeOff, 'off must preserve every role and version');
    result.fixture = evidenceBody({ company: fixture.A.id, otherCompany: fixture.B.id, actorAdmin: admin.userId,
      actorMember: member.userId, role: role.key, scope: role.scope });
    result.dataHashBefore = dataHashBefore;

    vite = await createServer({
      configFile: false,
      root: path.join(root, 'frontend'),
      envDir: process.env.DEADLINE_TEMP_ROOT,
      cacheDir: path.join(process.env.DEADLINE_TEMP_ROOT, 'vite-cache'),
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': new URL(api.baseUrl).origin }, watch: { ignored: ['**/.omo/**', '**/dist/**'] } },
    });
    await vite.listen();
    const port = vite.httpServer.address().port;
    assert.ok(!protectedPorts.has(port));
    result.resources.push({ kind: 'vite', pid: process.pid, port, closed: false });
    const origin = `http://127.0.0.1:${port}`;

    browserServer = await chromium.launchServer({ channel: 'chrome', headless: true, timeout: 20000,
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
    const child = browserServer.process();
    const controlPort = Number(new URL(browserServer.wsEndpoint()).port);
    const profile = child.spawnargs.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
    assert.ok(!protectedPorts.has(controlPort));
    result.resources.push({ kind: 'chrome', pid: child.pid, controllerPid: process.pid, port: controlPort, profile, closed: false });
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 10000 });
    result.chrome = browser.version();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && !protectedPorts.has(Number(url.port))) return route.continue();
      result.blockedBrowserRequests.push({ method: route.request().method(), url: url.href });
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      if (url.host === new URL(origin).host) socket.connectToServer();
      else { result.blockedBrowserRequests.push({ method: 'WEBSOCKET', url: url.href }); socket.close(); }
    });
    await context.addInitScript(session => {
      localStorage.setItem('orbitflow.session.v1', JSON.stringify(session));
      localStorage.setItem('orbitflow.demoMode', '0');
    }, admin.session);
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => result.errors.push({ phase: 'page', message: error.message }));
    page.on('response', response => {
      if (!new URL(response.url()).pathname.startsWith('/api/')) return;
      result.browserResponses.push({ method: response.request().method(), path: new URL(response.url()).pathname, status: response.status() });
    });

    async function browserRequest(route, method = 'GET', body, expected = 200, actor = admin) {
      const record = await page.evaluate(async ({ route, method, body, actor }) => {
        const response = await fetch('/api/v1' + route, {
          method,
          headers: { Authorization: `Bearer ${actor.token}`, 'X-Org-Id': actor.orgId, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10000),
        });
        const text = await response.text();
        return { route, method, actor: actor.userId, orgId: actor.orgId, status: response.status, body: text ? JSON.parse(text) : null };
      }, { route, method, body, actor });
      result.http.push(evidenceBody(record));
      assert.equal(record.status, expected, JSON.stringify(evidenceBody(record)));
      return record.body;
    }

    const roleResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/settings/roles');
    await page.goto(origin + '/settings/roles', { waitUntil: 'domcontentloaded', timeout: 20000 });
    assert.equal((await roleResponse).status(), 200);
    const roleRow = page.getByTestId(`role-${role.key}`);
    await roleRow.waitFor({ state: 'visible' });
    assert.equal(await page.locator('a[href="/hr/attendance"]').count(), 0);
    assert.equal(await page.locator('a[href="/hr/leave"]').count(), 0);
    assert.equal(await page.getByTestId('screen-access-denied').count(), 0);
    for (const feature of roleFeatures) {
      const denied = await browserRequest(feature.api, 'GET', undefined, 403);
      assert.equal(denied.error.code, 'FEATURE_DISABLED');
    }
    const listedWhileOff = await browserRequest('/settings/roles');
    assert.equal(listedWhileOff.items.find(item => item.key === role.key).scope, 'all');
    const memberAccessWhileOff = await browserRequest('/settings/access', 'GET', undefined, 200, member);
    assert.deepEqual(memberAccessWhileOff.features, ['approvals']);
    assert.equal(memberAccessWhileOff.scope, 'all');

    // RED: the verified Task8 screen lacks the independent stored-grant/company-status surface.
    for (const feature of roleFeatures) {
      const status = roleRow.getByTestId(`role-feature-${feature.key}`);
      assert.equal(await status.count(), 1, `missing role-feature-${feature.key}`);
      assert.equal(await status.locator('[data-feature-status="disabled"]').count(), 1);
    }
    for (const [route, body] of [
      ['/hr/attendance', { on_date: '2026-09-10', kind: 'present', hours: 8, source: 'manual' }],
      ['/hr/leave-balances', { member_id: member.userId, kind: 'annual', granted_days: 1 }],
      [`/hr/leaves/${leave.id}/decide`, { decision: 'approve' }],
    ]) {
      const denied = await browserRequest(route, 'POST', body, 403);
      assert.equal(denied.error.code, 'FEATURE_DISABLED', 'finite company administrator cannot bypass off on writes');
    }
    assert.equal(hashRows(db()), dataHashBefore);
    result.assertions.off = { menusHidden: true, adminReadAndWriteCode: 'FEATURE_DISABLED', rolesSettingsAccessible: true,
      allRolesAndVersionsPreserved: true, memberScope: memberAccessWhileOff.scope, storedGrantCounts: { attendance: 2, leave: 2 } };

    result.geometry = {};
    let currentRole = listedWhileOff.items.find(item => item.key === role.key);
    const removals = new Map([[1280, 'attendance.read'], [768, 'menu.attendance'], [375, 'leave.approve']]);
    for (const [width, removedPermission] of removals) {
      await page.setViewportSize({ width, height: 900 });
      await roleRow.getByRole('button', { name: '수정', exact: true }).click();
      const editor = page.getByTestId('role-definition-editor');
      assert.equal(Number(await editor.getAttribute('data-version')), currentRole.version);
      const checkbox = editor.locator(`[data-permission="${removedPermission}"]`);
      assert.equal(await checkbox.isEnabled(), true, 'off feature must not lock authorized grant controls');
      assert.equal(await checkbox.isChecked(), true);
      assert.equal(await checkbox.locator('..').locator('[data-feature-status="disabled"]').count(), 1,
        'permission control must independently expose company feature availability');
      const writesBefore = result.browserResponses.filter(item => item.method !== 'GET').length;
      await checkbox.uncheck();
      assert.equal(await checkbox.isChecked(), false);
      assert.equal(result.browserResponses.filter(item => item.method !== 'GET').length, writesBefore);
      assert.deepEqual((await browserRequest('/settings/roles')).items.find(item => item.id === role.id), currentRole,
        'UI draft must not auto-save');
      await page.evaluate(() => { window.scrollTo({ top: 0, behavior: 'instant' }); return document.fonts.ready; });
      await page.screenshot({ path: path.join(evidence, `role-feature-status-${width}.png`), fullPage: true, animations: 'disabled' });
      const geometry = await page.evaluate(() => {
        const role = document.querySelector('.role-settings')?.getBoundingClientRect();
        const featureCards = [...document.querySelectorAll('.role-settings__feature-grants > span')].map(element => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width };
        });
        const controls = [...document.querySelectorAll('[data-testid="role-definition-editor"] input, [data-testid="role-definition-editor"] select, [data-testid="role-definition-editor"] button')].map(element => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
        });
        return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
          role: role ? { left: role.left, right: role.right, width: role.width } : null, featureCards, controls };
      });
      assert.equal(geometry.viewport, width);
      assert.ok(geometry.documentWidth <= width, JSON.stringify(geometry));
      assert.ok(geometry.role && geometry.role.left >= 0 && geometry.role.right <= width, JSON.stringify(geometry));
      assert.ok(geometry.featureCards.length > 0 && geometry.featureCards.every(card => card.left >= 0 && card.right <= width), JSON.stringify(geometry));
      assert.ok(geometry.controls.length > 0 && geometry.controls.every(control => control.width > 0 && control.left >= 0 && control.right <= width), JSON.stringify(geometry));
      result.geometry[width] = geometry;
      await editor.screenshot({ path: path.join(evidence, `role-editor-draft-${width}.png`), animations: 'disabled' });
      const expectedPermissions = currentRole.permissions.filter(code => code !== removedPermission);
      // Subscribe to the actual PATCH and the completed versioned UI refresh before pressing Save.
      const settled = await armDom(page, `.role-settings[aria-busy="false"] [data-testid="role-definition-editor"][data-version="${currentRole.version + 1}"]`);
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/settings/roles/${role.id}` && response.request().method() === 'PATCH');
      await editor.getByRole('button', { name: '역할 저장', exact: true }).click();
      const response = await responsePromise;
      const request = response.request().postDataJSON();
      const savedRole = await response.json();
      result.uiSaves.push({ width, removedPermission, before: currentRole, method: response.request().method(),
        path: new URL(response.url()).pathname, request, status: response.status(), response: savedRole, triggeredBy: 'role-definition-editor submit button' });
      assert.equal(response.status(), 200, JSON.stringify(savedRole));
      assert.equal(request.expected_version, currentRole.version);
      assert.deepEqual(new Set(request.permissions), new Set(expectedPermissions));
      assert.deepEqual(new Set(savedRole.permissions), new Set(expectedPermissions));
      assert.equal(savedRole.version, currentRole.version + 1);
      await settled();
      assert.equal(await page.getByTestId('role-save-receipt').count(), 1);
      assert.equal(await checkbox.isChecked(), false);
      assert.equal(await checkbox.isEnabled(), true);
      currentRole = savedRole;
      assert.deepEqual((await browserRequest('/settings/roles')).items.find(item => item.id === role.id), currentRole);
      const stillOff = await browserRequest('/settings/access', 'GET', undefined, 200, member);
      assert.deepEqual(stillOff.features, ['approvals'], 'UI grant saving must not enable company features');
      for (const feature of roleFeatures) {
        const denied = await browserRequest(feature.api, 'GET', undefined, 403);
        assert.equal(denied.error.code, 'FEATURE_DISABLED');
        assert.equal(await page.locator(`a[href="${feature.menu}"]`).count(), 0);
      }
      assert.equal(hashRows(db()), dataHashBefore);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: path.join(evidence, `role-editor-saved-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    result.mobile = result.geometry[375];
    result.assertions.ui = { realControlSaves: result.uiSaves.length, widths: [...removals.keys()],
      explicitServerVersions: result.uiSaves.map(save => [save.request.expected_version, save.response.version]),
      featureEnabledByEditing: false, hrRowsUnchangedAfterEverySave: true };

    const organizationResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/tenants/modules');
    await page.goto(origin + '/settings/organization', { waitUntil: 'domcontentloaded' });
    await organizationResponse;
    const attendanceToggle = page.getByRole('checkbox', { name: /^근태/ });
    const leaveToggle = page.getByRole('checkbox', { name: /^휴가/ });
    await attendanceToggle.waitFor({ state: 'visible' });
    assert.equal(await attendanceToggle.isChecked(), false);
    assert.equal(await leaveToggle.isChecked(), false);
    await attendanceToggle.check();
    await leaveToggle.check();
    const saveResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/tenants/current' && response.request().method() === 'PATCH');
    const accessRefresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/settings/access');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    const [saved, refreshed] = await Promise.all([saveResponse, accessRefresh]);
    assert.equal(saved.status(), 200);
    assert.equal(refreshed.status(), 200);

    const listedAfterOn = await browserRequest('/settings/roles');
    const roleAfterOn = listedAfterOn.items.find(item => item.key === role.key);
    assert.deepEqual(roleAfterOn, currentRole, 'feature on must not change any role field or restore revoked grants');
    assert.deepEqual(roleAfterOn.permissions, ['menu.leave']);
    const memberAccessAfterOn = await browserRequest('/settings/access', 'GET', undefined, 200, member);
    assert.deepEqual(memberAccessAfterOn.features, ['approvals', 'attendance', 'leave']);
    assert.equal(memberAccessAfterOn.permissions.includes('attendance.read'), false);
    const attendanceWithoutGrant = await browserRequest('/hr/attendance', 'GET', undefined, 403, member);
    assert.equal(attendanceWithoutGrant.error.code, 'PERMISSION_DENIED');
    assert.equal(memberAccessAfterOn.permissions.includes('leave.approve'), false);
    const leaveWithoutGrant = await browserRequest(`/hr/leaves/${leave.id}/decide`, 'POST', { decision: 'approve' }, 403, member);
    assert.equal(leaveWithoutGrant.error.code, 'PERMISSION_DENIED');
    await browserRequest('/hr/attendance');
    await browserRequest('/hr/leaves');
    assert.deepEqual(await api.request(fixture.B.actor, '/tenants/current'), otherCompanyBefore, 'other company defaults and data must remain unchanged');
    assert.equal(hashRows(db()), dataHashBefore, 'feature and role changes must preserve HR records');
    result.dataHashAfter = hashRows(db());
    result.assertions.on = { revokedAttendanceGrantRestored: false, revokedLeaveApprovalRestored: false, leaveMenuPreserved: true,
      memberAttendanceStatus: 403, memberAttendanceCode: attendanceWithoutGrant.error.code,
      memberLeaveDecisionStatus: 403, memberLeaveDecisionCode: leaveWithoutGrant.error.code, otherCompanyUnchanged: true };

    const refreshedRoles = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/settings/roles');
    await page.goto(origin + '/settings/roles', { waitUntil: 'domcontentloaded' });
    await refreshedRoles;
    const refreshedRoleRow = page.getByTestId(`role-${role.key}`);
    await refreshedRoleRow.waitFor({ state: 'visible' });
    assert.equal(await refreshedRoleRow.getByTestId('role-feature-attendance').count(), 0);
    assert.equal(await refreshedRoleRow.getByTestId('role-feature-leave').locator('[data-feature-status="enabled"]').count(), 1);
    await page.screenshot({ path: path.join(evidence, 'screen.png'), fullPage: true, animations: 'disabled' });

    assert.equal(networkAudit.blocked.length, 0);
    assert.ok(result.blockedBrowserRequests.every(request => new URL(request.url).hostname === 'cdn.jsdelivr.net'));
    result.limitations = ['External font stylesheet was blocked; screenshots use the system font fallback.'];
    assert.equal(result.dataHashAfter, result.dataHashBefore);
    assert.deepEqual(result.errors, []);
    result.status = 'passed';
  } catch (error) {
    result.status = controller.signal.aborted ? 'cancelled' : 'failed';
    result.errors.push({ phase: 'scenario', message: error.message, stack: error.stack });
    if (page) {
      try { await page.screenshot({ path: path.join(evidence, 'red-screen.png'), fullPage: true, animations: 'disabled' }); }
      catch (captureError) { result.errors.push({ phase: 'failure-capture', message: captureError.message }); }
    }
    console.error(error);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    const cleanupErrors = [];
    async function close(kind, action) {
      try {
        await action();
        const resource = result.resources.find(item => item.kind === kind);
        if (resource) resource.closed = true;
      } catch (error) { cleanupErrors.push({ kind, message: error.message }); }
    }
    await close('context', async () => { await context?.unrouteAll({ behavior: 'wait' }); await context?.close(); });
    await close('browser', () => browser?.close());
    await close('chrome', () => browserServer?.close());
    const chromeResource = result.resources.find(item => item.kind === 'chrome');
    if (chromeResource?.profile) chromeResource.profileRemoved = !existsSync(chromeResource.profile);
    await close('vite', () => vite?.close());
    await close('api', () => api?.close());
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    process.off('message', onMessage);
    result.http = [...(api?.http ?? []), ...result.http];
    result.network = networkAudit;
    if (cleanupErrors.length) { result.status = 'failed'; process.exitCode = 1; }
    const cleanup = { status: cleanupErrors.length ? 'failed' : 'complete', resources: result.resources,
      errors: cleanupErrors, browserExited: browserServer ? browserServer.process().exitCode !== null : null,
      protectedPorts: [...protectedPorts], liveServiceRequests: 0 };
    await writeFile(path.join(evidence, 'scenario.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify(cleanup, null, 2));
    console.log(JSON.stringify({ scenario: result.scenario, status: result.status, evidence, cleanup: cleanup.status }));
  }
}
