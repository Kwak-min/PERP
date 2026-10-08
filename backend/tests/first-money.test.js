import test from 'node:test';
import { firstMoneyScenarios } from './first-money-scenarios.js';
test('ordinary empty organization prepares and records first income and receipt expense', { timeout: 120000 }, () => firstMoneyScenarios());
