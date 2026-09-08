import {test} from 'node:test';
import {exerciseJobs} from './deadline-wiki-jobs-fixture.js';

test('native PostgreSQL18 durable Wiki jobs and actual transactional lease races',{timeout:180000},async()=>{await exerciseJobs('pg');});
