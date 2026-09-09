import assert from 'node:assert/strict';
import test from 'node:test';
import { MODULE_CATALOG } from '../../backend/src/config/modules.js';
import { COMPANY_PERMISSIONS } from '../../backend/src/config/rbac.js';
import { permissionCatalog } from '../../backend/src/services/company-roles.service.js';
import { allRoutePaths, navigation, screens } from '../src/routes/catalog.ts';
import { actionPermissionLabels } from '../src/screens/action-permission-labels.ts';

test('calendar and HR use the requested product labels', () => {
  assert.equal(MODULE_CATALOG.find(module => module.key === 'calendar')?.label, '캘린더');
  assert.equal(MODULE_CATALOG.find(module => module.key === 'hr')?.label, '인사');
});

test('recruitment has no product screen, route, navigation, or configurable permission', () => {
  assert.equal(screens.some(screen => screen.id === 'HR-004'), false);
  assert.equal(allRoutePaths.includes('/hr/recruitment'), false);
  assert.equal(navigation.some(screen => screen.path === '/hr/recruitment'), false);
  assert.equal(permissionCatalog.some(item => item.code === 'menu.recruitment' || item.code === 'recruitment.manage'), false);
  assert.equal(Object.hasOwn(actionPermissionLabels, 'recruitment.manage'), false);
});

test('projects and tasks stay separate while retired recruitment authority remains data-compatible', () => {
  assert.equal(screens.find(screen => screen.id === 'PRJ-001')?.path, '/projects');
  assert.equal(screens.find(screen => screen.id === 'TSK-001')?.path, '/tasks');
  assert.ok(COMPANY_PERMISSIONS.includes('menu.recruitment'));
  assert.ok(COMPANY_PERMISSIONS.includes('recruitment.manage'));
});
