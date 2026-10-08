import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError, invalid } from '../utils/errors.js';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
export const WIKI_CONTRACT = deepFreeze({ version: 1, sqliteMigration: 12, pgMigration: 15,
  limits: { sourceBytes: 1000000, sources: 20, pages: 20, edges: 200, question: 4000, outputBytes: 262144 },
  jobStates: ['queued','running','succeeded','failed','unavailable'], changeSetStates: ['draft','published','rejected'],
  pageStates: ['published','withdrawn'], freshness: ['current','stale','unavailable'],
  inputKinds: ['source_revision','page_revision','catalog','question','instruction','schema_revision','prior_result'],
});
const id = z.string().min(1).max(200);
const version = z.union([z.number().int().nonnegative(), z.string().min(1).max(100)]);
export const sourceRegistrationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('record'), origin_kind: z.enum(['note','document']), origin_id: id, version }).strict(),
  z.object({ kind: z.literal('upload'), filename: z.string().min(1).max(255), mime: z.string().min(1).max(100), content_base64: z.string().min(1) }).strict(),
]);
export const recaptureSchema = z.object({ expected_version: z.number().int().positive(), version: version.optional(), filename: z.string().min(1).max(255).optional(), mime: z.string().min(1).max(100).optional(), content_base64: z.string().min(1).optional() }).strict();
export const sourceCasSchema = z.object({ expected_version: z.number().int().positive() }).strict();
export const citationSchema = z.object({ artifact_kind: z.enum(['source_revision','page_revision']), revision_id: id,
  revision_sha256: z.string().regex(/^[a-f0-9]{64}$/), start_byte: z.number().int().nonnegative(), end_byte: z.number().int().positive(), span_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

function bytesFor(revision) { return Buffer.from(revision.content ?? revision.markdown, 'utf8'); }
function span(bytes, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > bytes.length ||
      (start < bytes.length && (bytes[start] & 0xc0) === 0x80) || (end < bytes.length && (bytes[end] & 0xc0) === 0x80)) throw invalid('invalid UTF-8 byte span');
  return bytes.subarray(start, end);
}
export function citationFor(revision, start_byte = 0, end_byte = bytesFor(revision).length) {
  const bytes = bytesFor(revision), selected = span(bytes, start_byte, end_byte);
  return deepFreeze(citationSchema.parse({ artifact_kind: revision.artifact_kind, revision_id: revision.id,
    revision_sha256: sha256(bytes), start_byte, end_byte, span_sha256: sha256(selected) }));
}
export function restoreSpan(revision, input) {
  const citation = citationSchema.parse(input), bytes = bytesFor(revision);
  if (revision.id !== citation.revision_id || revision.artifact_kind !== citation.artifact_kind || sha256(bytes) !== citation.revision_sha256) throw invalid('citation revision mismatch');
  const selected = span(bytes, citation.start_byte, citation.end_byte);
  if (sha256(selected) !== citation.span_sha256) throw invalid('citation span hash mismatch');
  return selected.toString('utf8');
}

// Provenance must be lossless JSON data, not Date/Map/undefined/NaN or capabilities.
function assertJsonData(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!value || typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && ![Object.prototype,null].includes(Object.getPrototypeOf(value)))) throw invalid('manifest requires JSON data');
  seen.add(value);
  if (Reflect.ownKeys(value).some(key => typeof key === 'symbol')) throw invalid('manifest requires JSON data');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw invalid('manifest requires dense JSON arrays');
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(descriptors,String(i))) throw invalid('manifest requires dense JSON arrays');
    delete descriptors.length;
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor,'value')) throw invalid('manifest requires JSON data');
    assertJsonData(descriptor.value,seen);
  }
  seen.delete(value);
}
// 제공 순서/전체 문맥을 고정한다. catalog/result는 비인용 원본까지 명시해야 한다.
export function freezeManifest(inputs) {
  assertJsonData(inputs);
  const frozen = inputs.map((input, ordinal) => {
    if (!WIKI_CONTRACT.inputKinds.includes(input.kind) || typeof input.supplied_text !== 'string' || !input.authorization || !input.classification) throw invalid('incomplete dispatched input');
    if (['catalog','prior_result'].includes(input.kind) && !Array.isArray(input.source_revision_ids)) throw invalid('context requires complete raw closure');
    if (['source_revision','page_revision','schema_revision'].includes(input.kind) && !input.revision_id) throw invalid('missing input revision');
    return { ...JSON.parse(canonical(input)), ordinal, supplied_sha256: sha256(Buffer.from(input.supplied_text)) };
  });
  return deepFreeze({ inputs: frozen, hash: sha256(canonical(frozen)) });
}
export function rankAuthorized(candidates, question, score = candidate => {
  const text = candidate.content.toLocaleLowerCase();
  return [...new Set(question.toLocaleLowerCase().split(/\s+/).filter(Boolean))].filter(term => text.includes(term)).length;
}) {
  return candidates.filter(candidate => candidate.authorized === true).map(candidate => ({ ...candidate, score: score(candidate, question) }))
    .filter(candidate => candidate.score > 0).sort((a,b) => b.score - a.score || a.id.localeCompare(b.id));
}
export const wikiError = (code, status, message = code) => new ApiError(code, message, {}, status);
