import { createServer } from "node:http";
import { once } from "node:events";

// 합성 추론 wire: 의미 품질을 증명하는 모델이 아니라 모델 출력 계약만 재현한다.
export async function startEmbeddingFixture() {
  const calls = [];
  let mode = "ok", gate = null;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ path: req.url, body });
    server.emit("inference", body);
    if (gate) await gate;
    res.setHeader("Content-Type", "application/json");
    if (mode === "error") { res.writeHead(503); res.end('{"error":"fixture unavailable"}'); return; }
    if (mode === "redirect") { res.writeHead(307, { Location: "/must-not-follow" }); res.end(); return; }
    const embeddings = body.input.map(text => text.includes("SYNTH_RELATED") ? [1, 0, 0] : text.includes("SYNTH_PARAPHRASE") ? [0.99, 0.1, 0] : [0, 0, 1]);
    res.end(JSON.stringify({ embeddings: mode === "malformed" ? [[0, 0]] : embeddings }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening", { signal: AbortSignal.timeout(5000) });
  return { calls, server, baseUrl: `http://127.0.0.1:${server.address().port}`, set mode(value) { mode = value; }, set gate(value) { gate = value; },
    async close() { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
