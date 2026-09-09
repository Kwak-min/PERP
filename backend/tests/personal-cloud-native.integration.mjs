import {test} from 'node:test';
import {personalCloudScenario} from './personal-cloud-scenarios.js';
test('native PG personal graph and Wiki require exact scoped approval', {timeout:120000},()=>personalCloudScenario('pg'));
