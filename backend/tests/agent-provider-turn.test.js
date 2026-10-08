import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

describe("agent provider protocol", { timeout: 15000 }, () => {
  let wire, providers, env;
  let respond;
  const calls = [];
  const messages = [{ role: "user", content: "Find my tasks." }];
  const tools = [{ type: "function", function: { name: "query_search_tasks", parameters: {
    type: "object", properties: {}, additionalProperties: false,
  } } }];
  const toolCall = { id: "call_1", type: "function", function: { name: "query_search_tasks", arguments: "{}" } };
  const turn = (extra = {}) => providers.completeTurn({ messages, tools, classification: "internal", ...extra }, "external",
    providers.openRouterForKey("synthetic-agent-key"));

  before(async () => {
    wire = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      calls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(text) });
      respond(req, res);
    });
    const listening = once(wire, "listening", { signal: AbortSignal.timeout(5000) });
    wire.listen(0, "127.0.0.1");
    await listening;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${wire.address().port}/external`;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${wire.address().port}/local`;
    process.env.OPENROUTER_API_KEY = "";
    ({ env } = await import("../src/config/env.js"));
    providers = await import("../src/services/ai-provider.service.js");
  });
  after(async () => {
    wire.closeAllConnections();
    await new Promise((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
  });
  const reply = (message, extra = {}) => {
    respond = (_req, res) => res.end(JSON.stringify({
      model: "wire-agent", choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }, ...extra,
    }));
  };

  it("accepts null-content function calls and preserves matching tool history", async () => {
    reply({ content: null, tool_calls: [toolCall] });
    const result = await turn();
    assert.equal(result.content, "");
    assert.deepEqual(result.tool_calls, [toolCall]);
    assert.equal(result.usage.prompt_tokens, 7);
    assert.equal(result.provider, "openrouter");
    assert.equal(calls.at(-1).path, "/external/chat/completions");
    assert.equal(calls.at(-1).authorization, "Bearer synthetic-agent-key");
    assert.deepEqual(calls.at(-1).body.tools, tools);
    const history = [...messages, { role: "assistant", content: null, tool_calls: [toolCall] },
      { role: "tool", tool_call_id: "call_1", content: '{"result":[]}' }];
    reply({ content: "No matching tasks." });
    assert.equal((await turn({ messages: history })).content, "No matching tasks.");
    assert.deepEqual(calls.at(-1).body.messages, history);
  });

  it("keeps existing text-only complete compatible", async () => {
    reply({ content: "text-compatible" });
    const result = await providers.openRouterForKey("synthetic-text-key").complete("wire-model", "System", "User");
    assert.equal(result.text, "text-compatible");
    assert.equal(result.error, null);
    assert.equal(calls.at(-1).body.tools, undefined);
  });

  it("forwards the server-owned extraction response schema without adding tools", async () => {
    const response_format = { type: "json_schema", json_schema: {
      name: "knowledge_notes", strict: true,
      schema: { type: "object", properties: { notes: { type: "array", items: { type: "string" } } },
        required: ["notes"], additionalProperties: false },
    } };
    reply({ content: '{"notes":[]}' });
    await turn({ tools: [], response_format });
    assert.deepEqual(calls.at(-1).body.response_format, response_format);
    assert.equal(calls.at(-1).body.tools, undefined);
  });

  it("routes unknown, classified history and credential-like contents locally", async () => {
    reply({ content: "local-only" });
    for (const options of [
      { classification: "unknown" },
      { classification: "sensitive" },
      { classification: "public", messages: [{ role: "user", content: "historic", classification: "confidential" }] },
      { classification: "public", messages: [{ role: "user", content: "api_key=synthetic-private-value" }] },
    ]) {
      const result = await turn(options);
      assert.equal(result.provider, "ollama");
      assert.equal(calls.at(-1).path, "/local/v1/chat/completions");
      assert.equal(calls.at(-1).authorization, undefined);
      assert.ok(calls.at(-1).body.messages.every(message => !Object.hasOwn(message, "classification")));
    }
  });

  it("rejects truncated, malformed and oversized responses without echo fallback or secret diagnostics", async () => {
    for (const response of [
      (_req, res) => { res.writeHead(401); res.end("synthetic-agent-key"); },
      (_req, res) => res.end("{synthetic-agent-key"),
      (_req, res) => res.end(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "partial" } }] })),
      (_req, res) => res.end(JSON.stringify({ choices: [{ message: { content: null } }] })),
      (_req, res) => res.end("x".repeat(300000)),
    ]) {
      respond = response;
      const start = calls.length;
      await assert.rejects(turn(), error => error.code === "SERVICE_UNAVAILABLE" && !error.message.includes("synthetic-agent-key"));
      assert.equal(calls.length, start + 1);
    }
  });

  it("cancels a real pending provider request on its exact request event", async () => {
    const controller = new AbortController();
    const arrived = Promise.withResolvers();
    respond = () => arrived.resolve();
    const rejected = assert.rejects(turn({ signal: controller.signal }), error => error.code === "SERVICE_UNAVAILABLE"
      && error.details.reason === "aborted");
    await arrived.promise;
    controller.abort();
    await rejected;
  });

  it("never turns agent provider unavailability into an echo success", async () => {
    const localUrl = providers.REGISTRY.ollama.baseUrl;
    const previous = env.aiProvider;
    providers.REGISTRY.ollama.baseUrl = "";
    env.aiProvider = "echo";
    try {
      await assert.rejects(providers.completeTurn({ messages, tools, classification: "sensitive" }),
        error => error.code === "SERVICE_UNAVAILABLE");
    } finally {
      providers.REGISTRY.ollama.baseUrl = localUrl;
      env.aiProvider = previous;
    }
  });
});
