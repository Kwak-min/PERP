import { test } from 'node:test';
import { exerciseKnowledgeCloud } from './knowledge-cloud-scenarios.js';
test('SQLite settings key drives guarded Wiki compilation and real embeddings HTTP', {timeout:120000}, async()=>exerciseKnowledgeCloud('legacy'));
