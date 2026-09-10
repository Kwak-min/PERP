import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestKey } from '../src/services/requestKey.ts';
import { matchesProjectSearch, matchesTaskSearch } from '../src/screens/projects/model.ts';

test('request keys work without secure-context randomUUID and retain UUID v4 entropy', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Crypto.prototype, 'randomUUID');
  Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true });
  try {
    const keys = Array.from({ length: 100 }, createRequestKey);
    assert.equal(new Set(keys).size, keys.length);
    keys.forEach(key => assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
  } finally { Object.defineProperty(Crypto.prototype, 'randomUUID', descriptor); }
});

test('project/task search handles whitespace, project context, assignee and description', () => {
  const project = { id: 'p', name: 'Launch', description: 'Quarterly work', status: 'active' };
  const task = { id: 't', project_id: 'p', title: 'Review', status: 'todo', assignee_name: '홍길동' };
  assert.equal(matchesProjectSearch(project, '  LAUNCH  '), true);
  assert.equal(matchesProjectSearch(project, 'quarterly'), true);
  assert.equal(matchesTaskSearch(task, 'launch', project), true);
  assert.equal(matchesTaskSearch(task, ' 홍길동 ', project), true);
  assert.equal(matchesTaskSearch(task, 'not present', project), false);
});
