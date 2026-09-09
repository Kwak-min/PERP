import assert from 'node:assert/strict';
import { test } from 'node:test';
import { citationFor, restoreSpan, freezeManifest, rankAuthorized } from '../src/services/knowledge-wiki-contract.service.js';

test('immutable UTF-8 byte anchors preserve Korean, CRLF and duplicate passages', () => {
  const text = '한글😀\r\n같은 구절\r\n같은 구절';
  const bytes = Buffer.from(text);
  const revision = { id: 'r', artifact_kind: 'source_revision', content: text };
  const start = Buffer.byteLength('한글😀\r\n같은 구절\r\n');
  const citation = citationFor(revision, start, bytes.length);
  assert.equal(restoreSpan(revision, citation), '같은 구절');
  assert.throws(() => citationFor(revision, 1, bytes.length));
  assert.throws(() => restoreSpan({ ...revision, content: text + '수정' }, citation));
  assert.throws(() => restoreSpan(revision, { ...citation, span_sha256: '0'.repeat(64) }));
  assert.equal(citation.start_byte, start);
});

test('ranking receives only authorized candidates; full ordered manifest is not a citation subset', () => {
  const candidates = [{ id: 'public', content: '근거', authorized: true }, { id: 'private', content: '비밀', authorized: false }];
  const observed = [];
  const ranked = rankAuthorized(candidates, '근거', candidate => { observed.push(candidate.id); return 1; });
  assert.deepEqual(observed, ['public']);
  assert.deepEqual(ranked.map(x => x.id), ['public']);
  const inputs = [
    { kind: 'source_revision', revision_id: 'r', supplied_text: '근거', classification: 'internal', authorization: { actor_id: 'a' } },
    { kind: 'catalog', supplied_text: '비인용 catalog', classification: 'personal', authorization: { actor_id: 'a' }, source_revision_ids: ['private-r'] },
    { kind: 'question', supplied_text: '질문', classification: 'personal', authorization: { actor_id: 'a' } },
  ];
  const manifest = freezeManifest(inputs);
  assert.equal(manifest.inputs.length, 3);
  assert.deepEqual(manifest.inputs.map(x => x.ordinal), [0, 1, 2]);
  assert.ok(Object.isFrozen(manifest.inputs[1]));
  assert.notEqual(manifest.hash, freezeManifest([...inputs].reverse()).hash);
  assert.throws(() => freezeManifest([{ ...inputs[1], source_revision_ids: undefined }]));
});
