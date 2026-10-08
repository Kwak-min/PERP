import assert from 'node:assert/strict';
import { startDailyNativePostgres } from './daily-native-fixture.js';
import { firstMoneyScenarios } from './first-money-scenarios.js';
assert.equal(process.env.DEADLINE_ISOLATED, '1');
const native = await startDailyNativePostgres();
try { await firstMoneyScenarios(native); } finally { await native.close(); }
