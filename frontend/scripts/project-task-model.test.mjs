import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProjects, parseTasks, projectProgress, tasksForProject } from '../src/screens/projects/model.ts';

test('actual IDs, not duplicate names, define project membership and completion', () => {
  const projects = parseProjects({ items: [{ __id: 1, 프로젝트: '동일 이름', status: 'active' }, { __id: 2, 프로젝트: '동일 이름', status: 'active' }] }, true);
  const tasks = parseTasks({ items: [
    { __id: 10, project_id: 1, 업무: '완료', status: 'done' },
    { __id: 11, project_id: 1, 업무: '취소', status: 'cancelled' },
    { __id: 12, project_id: 2, 업무: '다른 프로젝트', status: 'done' },
  ] }, true);
  assert.equal(projects[0].id, '1');
  assert.deepEqual(tasksForProject(tasks, '1').map(t => t.id), ['10', '11']);
  assert.deepEqual(projectProgress(tasksForProject(tasks, '1')), { completed: 1, total: 2, percent: 50 });
  assert.deepEqual(projectProgress([]), { completed: 0, total: 0, percent: 0 });
  assert.deepEqual(projectProgress(tasksForProject(tasks, '2')), { completed: 1, total: 1, percent: 100 });
});

test('legacy unassigned tasks remain in all-task data but are never assigned to a project', () => {
  const tasks = parseTasks({ items: [
    { id: 'a', project_id: null, title: '미배정', status: 'done', version: 2 },
    { id: 'b', project_id: 'p', title: '배정', status: 'in_progress', version: 1 },
  ] }, false);
  assert.equal(tasks.length, 2); assert.deepEqual(tasksForProject(tasks, 'p').map(t => t.id), ['b']);
  assert.deepEqual(projectProgress(tasksForProject(tasks, 'p')), { completed: 0, total: 1, percent: 0 });
  assert.throws(() => parseTasks({ items: [{ __id: 1, 업무: '연결 누락', status: 'done' }] }, true));
  assert.equal(parseProjects({ items: [{ id: 'p', name: '프로젝트', status: 'active' }] }, false)[0].id, 'p');
});
