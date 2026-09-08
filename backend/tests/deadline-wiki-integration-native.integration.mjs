import {test} from 'node:test';
import {integrationContract} from './deadline-wiki-integration-contract.js';
test('native PostgreSQL18 integrated job/publication frozen contract',{timeout:60000},t=>integrationContract('pg',t));
