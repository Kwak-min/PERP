import { createHash } from 'node:crypto';
import { evidenceBody } from '../../backend/tests/deadline-fixture.js';

function requestRecord(request, actor) {
  const record = { origin: 'Chrome', initialActor: actor.id, orgId: request.headers()['x-org-id'], sessionFingerprint: createHash('sha256').update(request.headers().authorization ?? '').digest('hex'), route: new URL(request.url()).pathname, method: request.method() };
  if ((request.headers()['content-type'] ?? '').includes('application/json') && request.postData()) record.requestBody = evidenceBody(request.postDataJSON());
  return record;
}

// Incidental observations are synchronous metadata, never deferred body reads.
// Cancellation/downloads are evidence, not JSON responses with invented bodies.
export function observeApiResponses(page, actor, result) {
  const records = new WeakMap();
  page.on('response', response => {
    const request = response.request();
    if (!new URL(request.url()).pathname.startsWith('/api/')) return;
    const headers = response.headers();
    const download = /attachment/i.test(headers['content-disposition'] ?? '') || /^(image\/|application\/pdf)/i.test(headers['content-type'] ?? '');
    const record = { ...requestRecord(request, actor), status: response.status(), observation: download ? 'download' : 'incidental' };
    records.set(request, record); result.http.push(record);
  });
  page.on('requestfailed', request => {
    if (!new URL(request.url()).pathname.startsWith('/api/')) return;
    const failure = request.failure()?.errorText ?? 'unknown request failure';
    const record = records.get(request) ?? requestRecord(request, actor);
    record.observation = /ERR_ABORTED|cancelled/i.test(failure) ? 'cancelled' : 'transport-failure'; record.failure = failure;
    if (!records.has(request)) result.http.push(record);
    if (record.observation === 'transport-failure') result.errors.push(`${record.method} ${record.route}: ${failure}`);
  });
}

// Subscribe before triggering an action; await this body before navigation/close.
// Assertion responses are deliberately separate from best-effort observations.
export function captureJsonResponse(page, predicate, result) {
  return page.waitForResponse(predicate).then(async response => {
    const route = new URL(response.url()).pathname, method = response.request().method();
    let body;
    try { body = await response.json(); }
    catch (cause) { throw new Error(`${method} ${route}: required JSON body capture failed`, { cause }); }
    result?.http.push({ origin: 'Chrome assertion', route, method, status: response.status(), observation: 'required-body', body: evidenceBody(body) });
    return { response, body };
  });
}
