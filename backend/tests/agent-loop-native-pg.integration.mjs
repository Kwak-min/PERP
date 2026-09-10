import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";

const bin = process.env.ORG_TEST_PG_BIN;
assert.ok(bin, "ORG_TEST_PG_BIN must identify isolated native PostgreSQL binaries");
const temporary = await mkdtemp(path.join(tmpdir(), "perp-agent-loop-native-"));
const data = path.join(temporary, "data");
const execute = promisify(execFile);
const pgCommand = (name, args) => execute(path.join(bin, `${name}${process.platform === "win32" ? ".exe" : ""}`), args, { timeout: 60000 });
let started = false, client, wire;
try {
  const reservation = net.createServer();
  const reserved = once(reservation, "listening", { signal: AbortSignal.timeout(5000) });
  reservation.listen(0, "127.0.0.1"); await reserved;
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  await pgCommand("initdb", ["-D", data, "-U", "agent_test", "-A", "trust", "--encoding=UTF8", "--locale=C"]);
  await pgCommand("pg_ctl", ["-D", data, "-l", path.join(temporary, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"]);
  started = true;
  client = new pg.Client({ host: "127.0.0.1", port, database: "postgres", user: "agent_test", connectionTimeoutMillis: 5000 });
  await client.connect();
  const engine = (await client.query("SELECT version()")).rows[0].version;
  assert.match(engine, /PostgreSQL 18/);
  await client.query("CREATE TABLE project_money(company_id text, project_id text, budget numeric(18,2), spent numeric(18,2))");
  await client.query("INSERT INTO project_money VALUES('own','p1',123456789.12,3456789.01),('foreign','p2',999999999.99,9.99)");
  let dispatches = 0;
  let observation;
  wire = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    dispatches += 1;
    assert.equal(req.url, "/chat/completions");
    assert.equal(req.headers.authorization, "Bearer synthetic-native-loop");
    if (dispatches === 1) {
      assert.deepEqual(body.tools.map(tool => tool.function.name), ["query_get_project_money"]);
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
        id: "native_money", type: "function", function: { name: "query_get_project_money", arguments: '{"project_id":"p1"}' },
      }] } }] }));
    } else {
      observation = JSON.parse(body.messages.find(message => message.role === "tool").content);
      assert.equal(observation.result.budget, "123456789.12");
      assert.equal(observation.result.spent, "3456789.01");
      assert.equal(observation.result.remaining, "120000000.11");
      assert.ok(!JSON.stringify(body).includes("999999999.99"));
      res.end(JSON.stringify({ choices: [{ message: { content: `Remaining: ${observation.result.remaining}` } }] }));
    }
  });
  const listening = once(wire, "listening", { signal: AbortSignal.timeout(5000) });
  wire.listen(0, "127.0.0.1"); await listening;
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${wire.address().port}`;
  const providers = await import("../src/services/ai-provider.service.js");
  const { runAgent } = await import("../src/services/agent-loop.service.js");
  const result = await runAgent({ source: "pg", companyId: "own" }, {
    run_id: "native-run", conversation_id: "native-conversation", classification: "internal",
    messages: [{ role: "user", content: "Get the actual remaining project budget." }],
  }, {
    catalog: async () => [{ name: "get.project_money", stage: "read", authorized: true, implemented: true, callable: true,
      input_schema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"], additionalProperties: false } }],
    query: async (context, tool, input) => {
      assert.equal(tool, "get.project_money");
      const rows = (await client.query("SELECT budget,spent,budget-spent AS remaining FROM project_money WHERE company_id=$1 AND project_id=$2",
        [context.companyId, input.project_id])).rows;
      assert.equal(rows.length, 1);
      return { result: rows[0], evidence: [{ type: "project", id: input.project_id }], classification: "internal", truncated: false };
    },
    propose: async () => assert.fail("Read-only request must not propose"),
    completeTurn: options => providers.completeTurn(options, "external", providers.openRouterForKey("synthetic-native-loop")),
  });
  assert.equal(result.content, "Remaining: 120000000.11");
  assert.equal(dispatches, 2);
  assert.equal(result.actions.length, 0);
  console.log(JSON.stringify({ result: "AGENT_LOOP_NATIVE_PG_PASS", engine, dispatches, exact_money: observation.result,
    foreign_excluded: true, domain_writes: 0 }));
} finally {
  if (wire) {
    wire.closeAllConnections();
    await new Promise((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
  }
  await client?.end();
  if (started) await pgCommand("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(temporary, { recursive: true, force: true });
}
