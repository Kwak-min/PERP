import {test} from 'node:test';
import {integrationContract} from './deadline-wiki-integration-contract.js';
test('SQLite integrated job/publication frozen contract',{timeout:60000},t=>integrationContract('legacy',t));
