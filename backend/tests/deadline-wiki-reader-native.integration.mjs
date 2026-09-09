import { test } from 'node:test';
import { exerciseReaderJobs } from './deadline-wiki-reader-fixture.js';

test('native PostgreSQL18 HTTP reader research authorization', {timeout:120000}, async t=>exerciseReaderJobs('pg',t));
