import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

test('approval model retains display DTOs independently from stable business IDs', async () => {
  assert.equal(process.env.DEADLINE_ISOLATED, '1');
  const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), envDir: process.env.DEADLINE_TEMP_ROOT, server: { middlewareMode: true, watch: null, hmr: false, ws: false } });
  try {
    const { detailSchema, historySchema } = await vite.ssrLoadModule('/src/screens/approvals/model.ts');
    const raw = { id: '9007199254740993', requester_id: '9007199254740995', requester_display: { name: '요청자' }, decided_by: '9007199254740997', decided_by_display: { name: '결재자' }, title: '', form_key: 'generic', body: {}, status: 'approved', version: 7, form_snapshot: null, attachment_snapshot: [], predecessor_id: null, steps: [{ approver_id: 'stable-id', approver_display: { name: '배정 결재자' }, mode: 'sequential', kind: 'approve' }] };
    const detail = detailSchema.parse(raw);
    assert.deepEqual(detail.requester_display, raw.requester_display);
    assert.deepEqual(detail.decided_by_display, raw.decided_by_display);
    assert.equal(detail.decided_by, raw.decided_by);
    assert.deepEqual(detail.steps[0].approver_display, raw.steps[0].approver_display);
    assert.equal(detail.requester_id, raw.requester_id); assert.equal(detail.steps[0].approver_id, 'stable-id');
    const event = { id: '1', actor_id: 'stable-id', actor_display: { name: null }, action: 'decision.approve', status: 'approved', snapshot: { requester_id: raw.requester_id }, created_at: '2026-09-09T00:00:00Z' };
    assert.deepEqual(historySchema.parse({ items: [event] }).items[0], event);
    assert.equal(detailSchema.safeParse({ ...raw, requester_display: { name: 123 } }).success, false);
    const { requester_display, decided_by_display, ...old } = raw;
    assert.equal(detailSchema.safeParse(old).success, true);
  } finally { await vite.close(); }
});
