import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
export async function task28LocalProvider() {
  const events = new EventEmitter(), calls = [], gate = { hold: null };
  const server = createServer(async (req, res) => {
    if (req.url === '/api/v0/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'synthetic-local', state: 'loaded', loaded_context_length: 32768, arch: 'fixture', quantization: 'not-real-model' }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push(request);
    const hold = gate.hold;
    events.emit('dispatch', request);
    if (hold) await hold.promise;
    if (res.destroyed) return;
    const catalog = JSON.parse(request.messages.find(message => message.role === 'user').content);
    const citations = catalog.evidence.length ? [0] : [];
    const pages = catalog.operation === 'query' ? [] : ['page', 'entity', 'concept'].map((kind, index) => ({
      key: kind, target_page_id: null, kind, title: `Task28 ${kind}`, markdown: `Task28 ${kind} 합성 검토용 본문`, index_entry: `- Task28 ${kind}`, citations,
      links: index === 0 ? [{ target: 'entity', predicate: 'supports', direction: 'directed', citations }, { target: 'entity', predicate: 'contradicts', direction: 'directed', citations }]
        : [{ target: index === 1 ? 'concept' : 'page', predicate: 'related', direction: index === 1 ? 'undirected' : 'directed', citations }],
    }));
    const output = { answer_md: catalog.operation === 'query' && citations.length ? '한글 합성 근거에 대한 검토 전 답변입니다.' : null, citations, uncertainty: ['합성 경계 응답이며 모델 품질 검증이 아닙니다.'], pages, suggestions: [] };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: request.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(output) } }], usage: { prompt_tokens: 600, completion_tokens: 300 } }));
  });
  const ready = once(server, 'listening', { signal: AbortSignal.timeout(10000) });
  server.listen(0, '127.0.0.1');
  await ready;
  return { config: { base_url: `http://127.0.0.1:${server.address().port}`, model: 'synthetic-local', context_tokens: 32768, output_tokens: 2048, timeout_ms: 10000, temperature: 0 }, calls, gate,
    dispatched: () => once(events, 'dispatch', { signal: AbortSignal.timeout(10000) }),
    async close() { gate.hold?.resolve(); await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); },
  };
}
