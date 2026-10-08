import { test } from 'node:test';
import { exerciseKnowledgeCloud } from './knowledge-cloud-scenarios.js';
test('native PostgreSQL settings identity drives guarded Wiki and embeddings HTTP', {timeout:120000}, async()=>exerciseKnowledgeCloud('pg'));
