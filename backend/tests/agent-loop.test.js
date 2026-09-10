import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

describe("bounded planning loop through a real provider protocol", { timeout: 15000 }, () => {
  let wire, providers, loop, database;
  let respond, query, propose, capabilities;
  const requests = [];
  const context = { source: "legacy", principal: { tenantId: "tenant-1", userId: "owner-1" } };
  const capability = (name, stage = "read", extra = {}) => ({
    name, stage, authorized: true, implemented: true, callable: true,
    input_schema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false }, ...extra,
  });
  const call = (id, name, input = {}) => ({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });
  const reply = (res, content, tool_calls) => res.end(JSON.stringify({
    model: "loop-wire", choices: [{ finish_reason: tool_calls ? "tool_calls" : "stop", message: { content, ...(tool_calls ? { tool_calls } : {}) } }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }));
  const agent = (extra = {}) => loop.runAgent(context, {
    run_id: "run-1", conversation_id: "conversation-1", classification: "internal",
    messages: [{ role: "user", content: "Find the project and propose a task based on its name." }], ...extra,
  }, {
    catalog: async () => capabilities,
    query: (...args) => query(...args),
    propose: (...args) => propose(...args),
    completeTurn: options => providers.completeTurn(options, "external", providers.openRouterForKey("synthetic-loop-key")),
  });
  before(async () => {
    wire = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      requests.push({ path: req.url, body });
      respond(body, res);
    });
    const listening = once(wire, "listening", { signal: AbortSignal.timeout(5000) });
    wire.listen(0, "127.0.0.1"); await listening;
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${wire.address().port}/external`;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${wire.address().port}/local`;
    providers = await import("../src/services/ai-provider.service.js");
    loop = await import("../src/services/agent-loop.service.js");
    database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE project(id TEXT,name TEXT); INSERT INTO project VALUES('p1','Actual project'); CREATE TABLE task(title TEXT)");
  });
  after(async () => {
    database?.close();
    wire.closeAllConnections();
    await new Promise((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
  });

  it("retains goal and real observations, continues after plans, and returns only actual proposals", async () => {
    capabilities = [capability("search.projects"), capability("create.task", "execute"),
      capability("search.documents", "read", { authorized: false }), capability("execute.operation", "execute")];
    const seen = [];
    query = async (ctx, tool, input) => {
      assert.equal(ctx, context); assert.equal(tool, "search.projects"); assert.deepEqual(input, {});
      return { result: database.prepare("SELECT * FROM project").all(), evidence: [{ type: "project", id: "p1" }],
        classification: "internal", truncated: false };
    };
    const view = { id: "operation-1", tool: "create.task", version: 1, status: "preview",
      preview: { title: "Actual project task", fields: [], warnings: [] }, requires_confirmation: true,
      requires_approval: false, requires_reauth: false, classification: "internal", result: null };
    propose = async (ctx, input) => {
      assert.equal(ctx, context);
      seen.push(input);
      assert.equal(input.input.title, "Actual project task");
      return view;
    };
    let round = 0;
    respond = (body, res) => {
      round += 1;
      assert.ok(body.messages.some(message => message.role === "user" && message.content.includes("Find the project")));
      assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), ["propose_create_task", "query_search_projects"]);
      if (round === 1) return reply(res, "프로젝트를 확인한 뒤 업무 초안을 제안하겠습니다.",
        [call("project_lookup", "query_search_projects")]);
      const observation = body.messages.find(message => message.role === "tool" && message.tool_call_id === "project_lookup");
      assert.equal(JSON.parse(observation.content).result[0].name, "Actual project");
      if (round === 2) return reply(res, null, [call("task_draft", "propose_create_task", { title: "Actual project task" })]);
      assert.equal(JSON.parse(body.messages.find(message => message.tool_call_id === "task_draft").content).id, view.id);
      return reply(res, "프로젝트를 확인했고 업무 초안을 제안했습니다. 실행에는 사용자 확인이 필요합니다.");
    };
    const result = await agent();
    assert.equal(round, 3);
    assert.deepEqual(result.actions, [view]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].run_id, "run-1");
    assert.equal(seen[0].tool_call_id, "task_draft");
    assert.equal(seen[0].conversation_id, "conversation-1");
    assert.equal(result.tool_activity.filter(item => item.stage === "query").length, 1);
    assert.equal(result.tool_activity.filter(item => item.stage === "plan").length, 1);
    assert.equal(result.usage.prompt_tokens, 15);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM task").get().n, 0);
  });

  it("reclassifies observations before the next dispatch and never downgrades them", async () => {
    capabilities = [capability("search.projects")];
    for (const observation of [
      { result: { value: "classified" }, classification: "sensitive" },
      { result: { value: "unknown" }, classification: "future-class" },
      { result: { value: "password=synthetic-secret-value" }, classification: "public" },
    ]) {
      let round = 0;
      const start = requests.length;
      query = async () => ({ ...observation, evidence: [], truncated: false });
      respond = (_body, res) => {
        round += 1;
        if (round < 3) return reply(res, null, [call(`lookup_${round}`, "query_search_projects")]);
        return reply(res, "Observed.");
      };
      const result = await agent({ classification: "public" });
      assert.deepEqual(requests.slice(start).map(request => request.path),
        ["/external/chat/completions", "/local/v1/chat/completions", "/local/v1/chat/completions"]);
      assert.ok(["sensitive", "confidential"].includes(result.classification));
    }
  });

  it("denies aliases not bound to authorized capabilities before any domain call", async () => {
    capabilities = [capability("search.projects")];
    let invoked = 0;
    query = propose = async () => { invoked += 1; };
    for (const name of ["execute_operation", "confirm_operation", "query_search_documents", "search.projects", "propose_create_task"]) {
      respond = (_body, res) => reply(res, null, [call("forbidden", name)]);
      await assert.rejects(agent(), error => error.code === "PERMISSION_DENIED");
    }
    assert.equal(invoked, 0);
  });

  it("rejects invalid IDs, duplicate IDs, malformed arguments and credential arguments before side effects", async () => {
    capabilities = [capability("search.projects")];
    let invoked = 0;
    query = async () => { invoked += 1; };
    for (const calls of [
      [call("", "query_search_projects")],
      [call("duplicate", "query_search_projects"), call("duplicate", "query_search_projects")],
      [{ ...call("bad_json", "query_search_projects"), function: { name: "query_search_projects", arguments: "{" } }],
      [call("array", "query_search_projects", [])],
      [call("credentials", "query_search_projects", { reauth_password: "never-send-this" })],
      [call("too_big", "query_search_projects", { query: "x".repeat(17000) })],
    ]) {
      respond = (_body, res) => reply(res, null, calls);
      await assert.rejects(agent(), error => ["VALIDATION_ERROR", "SERVICE_UNAVAILABLE"].includes(error.code));
    }
    assert.equal(invoked, 0);
  });

  it("bounds four provider rounds and twelve calls without premature success", async () => {
    capabilities = [capability("search.projects")];
    query = async () => ({ result: [], evidence: [], classification: "internal", truncated: false });
    let round = 0;
    respond = (_body, res) => reply(res, null, [call(`round_${++round}`, "query_search_projects")]);
    await assert.rejects(agent(), error => error.details.reason === "round_limit");
    assert.equal(round, 4);
    let invoked = 0;
    query = async () => { invoked += 1; };
    respond = (_body, res) => reply(res, null, Array.from({ length: 13 }, (_, index) => call(`over_${index}`, "query_search_projects")));
    await assert.rejects(agent(), error => error.details.reason === "call_limit");
    assert.equal(invoked, 0);
  });

  it("bounds result and initial context bytes and propagates domain failures truthfully", async () => {
    capabilities = [capability("search.projects")];
    respond = (_body, res) => reply(res, null, [call("lookup", "query_search_projects")]);
    query = async () => ({ result: "x".repeat(66000), evidence: [], classification: "internal" });
    await assert.rejects(agent(), error => error.details.reason === "result_bytes");
    await assert.rejects(agent({ messages: [{ role: "user", content: "x".repeat(270000) }] }),
      error => error.details.reason === "context_bytes");
    query = async () => { throw Object.assign(new Error("revoked"), { code: "PERMISSION_DENIED" }); };
    await assert.rejects(agent(), error => error.code === "PERMISSION_DENIED");
  });

  it("cancels after a genuine observation before any next model dispatch", async () => {
    capabilities = [capability("search.projects")];
    const controller = new AbortController();
    const start = requests.length;
    query = async () => {
      controller.abort();
      return { result: [], evidence: [], classification: "internal", truncated: false };
    };
    respond = (_body, res) => reply(res, null, [call("cancelled_query", "query_search_projects")]);
    await assert.rejects(agent({ signal: controller.signal }), error => error.details.reason === "aborted");
    assert.equal(requests.length, start + 1);
  });

  it("does not invent observations from malformed domain callbacks", async () => {
    capabilities = [capability("search.projects")];
    respond = (_body, res) => reply(res, null, [call("empty_observation", "query_search_projects")]);
    query = async () => ({});
    await assert.rejects(agent(), error => error.details.reason === "observation_format");
  });

  it("rejects excessive argument nesting with a bounded validation error", async () => {
    capabilities = [capability("search.projects")];
    let input = {};
    for (let index = 0; index < 100; index += 1) input = { child: input };
    let invoked = 0;
    query = async () => { invoked += 1; return { result: [], evidence: [], classification: "internal", truncated: false }; };
    respond = (_body, res) => reply(res, null, [call("nested_input", "query_search_projects", input)]);
    await assert.rejects(agent(), error => error.code === "VALIDATION_ERROR");
    assert.equal(invoked, 0);
  });

  it("completes after exactly twelve genuine calls with matching IDs and remaining budget", async () => {
    capabilities = [capability("search.projects")];
    let round = 0;
    let invoked = 0;
    query = async () => ({ result: { count: ++invoked }, evidence: [], classification: "internal", truncated: false });
    respond = (body, res) => {
      const budget = JSON.parse(body.messages.at(-1).content);
      assert.equal(budget.remaining_calls, 12 - round * 4);
      round += 1;
      if (round < 4) return reply(res, null, Array.from({ length: 4 }, (_, index) => call(`batch_${round}_${index}`, "query_search_projects")));
      assert.equal(body.messages.filter(message => message.role === "tool").length, 12);
      return reply(res, "Twelve observations verified.");
    };
    const result = await agent();
    assert.equal(invoked, 12);
    assert.equal(round, 4);
    assert.equal(result.tool_activity.length, 12);
  });

  it("rechecks the live catalog before another dispatch after a gate is revoked", async () => {
    capabilities = [capability("search.projects")];
    query = async () => {
      capabilities = [capability("search.projects", "read", { authorized: false })];
      return { result: [], evidence: [], classification: "internal", truncated: false };
    };
    let round = 0;
    respond = (body, res) => {
      round += 1;
      if (round === 1) return reply(res, null, [call("allowed", "query_search_projects")]);
      assert.equal(body.tools, undefined);
      return reply(res, null, [call("revoked", "query_search_projects")]);
    };
    await assert.rejects(agent(), error => error.code === "PERMISSION_DENIED");
    assert.equal(round, 2);
  });

  it("aborts even an injected callback that does not implement cancellation", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers();
    const stopped = assert.rejects(loop.runAgent(context, {
      run_id: "run-abort", messages: [], classification: "internal", signal: controller.signal,
    }, {
      catalog: () => { started.resolve(); return new Promise(() => {}); },
      query: () => { assert.fail("query must not start"); },
      propose: () => { assert.fail("proposal must not start"); },
      completeTurn: () => { assert.fail("provider must not start"); },
    }), error => error.details.reason === "aborted");
    await started.promise;
    controller.abort();
    await stopped;
  });

  const uiContext = { ...context, knowledgeMode: "company", protectedResultPolicy: "ui_only" };
  const readNames = ["search.projects", "search.tasks", "search.documents", "search.events",
    "search.transactions", "search.members", "get.brief", "get.project_money"];
  const receipt = (tool = "search.projects") => ({ kind: "protected_query", tool, status: "protected_result", truncated: false,
    ...(["search.projects", "search.tasks"].includes(tool) ? { items: [{ id: "entity-1", version: 2 }] } : {}) });
  const fullQuery = (tool = "search.projects") => ({ result: { items: [{ id: "entity-1", version: 2,
    title: "PROTECTED_TITLE_SENTINEL", body: "PROTECTED_BODY_SENTINEL", amount: "120000000.11" }] },
    evidence: [{ id: "PROTECTED_EVIDENCE_SENTINEL" }], classification: "confidential", truncated: false, provider_receipt: receipt(tool) });
  const fullAction = (tool = "create.task") => ({ id: "operation-1", tool, status: "preview", version: 1,
    preview: { title: "PROTECTED_PREVIEW_SENTINEL", fields: [{ label: "amount", value: "120000000.11" }] },
    requires_confirmation: true, requires_approval: false, requires_reauth: false, classification: "confidential",
    provider_receipt: { kind: "operation_preview", tool, id: "operation-1", status: "preview",
      requires_confirmation: true, requires_approval: false, requires_reauth: false } });
  const projected = (dependencies, options = {}, ctx = uiContext) => loop.runAgent(ctx, {
    run_id: "projection-run", conversation_id: "projection-conversation", classification: "public",
    messages: [{ role: "user", content: "Find permitted projects and tasks; propose a follow-up and task status change." }], ...options,
  }, dependencies);

  it("projects cloud-only safe IDs into dependent proposals and final without leaking full UI results", async () => {
    const localUrl = providers.REGISTRY.ollama.baseUrl;
    providers.REGISTRY.ollama.baseUrl = "";
    const start = requests.length, queries = new Map(), actions = [], classes = [], targets = [];
    database.exec("CREATE TABLE projection_entity(id TEXT,version INTEGER,company_id TEXT,title TEXT,body TEXT,amount TEXT); "
      + "INSERT INTO projection_entity VALUES('entity-1',2,'tenant-1','PROTECTED_TITLE_SENTINEL','PROTECTED_BODY_SENTINEL','120000000.11'),"
      + "('FOREIGN_ID_SENTINEL',3,'foreign','FOREIGN_TITLE_SENTINEL','FOREIGN_BODY_SENTINEL','999999999.99'); "
      + "CREATE TABLE projection_operation(id TEXT,status TEXT)");
    const taskCount = database.prepare("SELECT COUNT(*) AS n FROM task").get().n;
    let round = 0;
    respond = (body, res) => {
      if (++round === 1) return reply(res, null, readNames.map((tool, i) => call('protected_' + i, 'query_' + tool.replaceAll('.', '_'))));
      const observations = body.messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content));
      for (const [i, tool] of readNames.entries()) assert.deepEqual(observations[i], receipt(tool));
      if (round === 2) return reply(res, null, [
        call("draft_create", "propose_create_task", { project_id: observations[0].items[0].id, title: "User requested follow-up" }),
        call("draft_update", "propose_update_task_status", { task_id: observations[1].items[0].id,
          expected_version: observations[1].items[0].version, status: "done" }),
      ]);
      assert.deepEqual(observations.slice(8), actions.map(action => action.provider_receipt));
      assert.deepEqual(JSON.parse(body.messages.at(-1).content).pending_approvals, actions.map(({ id, tool, status }) => ({ id, tool, status })));
      return reply(res, "Protected results are displayed in the app, not read by me. Drafts await your confirmation.");
    };
    try {
      assert.equal(providers.REGISTRY.ollama.available(), false);
      const result = await projected({
        catalog: async () => [...readNames.map(tool => capability(tool)), capability("create.task", "execute"), capability("update.task_status", "execute")],
        query: async (ctx, tool) => {
          assert.equal(ctx, uiContext);
          const view = fullQuery(tool);
          view.result.items = database.prepare("SELECT id,version,title,body,amount FROM projection_entity WHERE company_id=?").all(ctx.principal.tenantId);
          if (view.provider_receipt.items) view.provider_receipt.items = view.result.items.map(({ id, version }) => ({ id, version }));
          queries.set(tool, view);
          return view;
        },
        propose: async (ctx, payload) => {
          assert.equal(ctx, uiContext);
          assert.equal(payload.run_id, "projection-run"); assert.equal(payload.conversation_id, "projection-conversation");
          assert.deepEqual(payload.input, payload.tool === "create.task"
            ? { project_id: "entity-1", title: "User requested follow-up" }
            : { task_id: "entity-1", expected_version: 2, status: "done" });
          const view = fullAction(payload.tool);
          view.id = view.provider_receipt.id = 'operation-' + payload.tool_call_id;
          database.prepare("INSERT INTO projection_operation VALUES(?,?)").run(view.id, view.status);
          actions.push(view); return view;
        },
        completeTurn: options => {
          classes.push(options.classification);
          return providers.completeTurn({ ...options, beforeDispatch: target => { targets.push(target); } },
            "external", providers.openRouterForKey("synthetic-projection-key"));
        },
      });
      assert.equal(round, 3);
      assert.deepEqual(classes, ["public", "internal", "internal"]);
      assert.ok(targets.length === 3 && targets.every(target => target.external && target.provider === "openrouter"));
      assert.equal(result.classification, "confidential"); assert.equal(result.content_classification, "internal");
      assert.deepEqual(result.actions, actions);
      assert.deepEqual(result.protected_results, readNames.map((tool, i) => ({ tool_call_id: 'protected_' + i, tool,
        result: queries.get(tool).result, evidence: queries.get(tool).evidence, classification: "confidential", truncated: false, status: "protected" })));
      assert.deepEqual(requests.slice(start).map(request => request.path), Array(3).fill("/external/chat/completions"));
      for (const request of requests.slice(start)) for (const hidden of ["PROTECTED_TITLE_SENTINEL", "PROTECTED_BODY_SENTINEL",
        "PROTECTED_EVIDENCE_SENTINEL", "PROTECTED_PREVIEW_SENTINEL", "120000000.11", "FOREIGN_ID_SENTINEL",
        "FOREIGN_TITLE_SENTINEL", "FOREIGN_BODY_SENTINEL", "999999999.99"]) assert.ok(!JSON.stringify(request).includes(hidden), hidden);
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM task").get().n, taskCount);
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM projection_operation WHERE status='preview'").get().n, 2);
    } finally { providers.REGISTRY.ollama.baseUrl = localUrl; }
  });

  it("rejects missing, malformed, extra and mismatched receipts before any continuation", async () => {
    const invalidQueries = [undefined, null, [], {}, { ...receipt(), tool: "search.tasks" },
      { ...receipt(), kind: "operation_preview" }, { ...receipt(), status: "preview" },
      { ...receipt(), truncated: "false" }, { ...receipt(), truncated: true },
      { ...receipt(), items: "entity-1" }, { ...receipt(), items: [null] },
      ...["title", "amount", "count", "evidence", "actor", "workspace", "mode", "result", "preview"].map(key => ({ ...receipt(), [key]: "HIDDEN" })),
      ...["", 1, null].map(id => ({ ...receipt(), items: [{ id, version: 2 }] })),
      ...[0, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1].map(version => ({ ...receipt(), items: [{ id: "entity-1", version }] })),
      { ...receipt(), items: [{ id: "entity-1", version: 2, title: "HIDDEN" }] }];
    const invalidProposals = [undefined, null, [], {},
      ...[{ id: "wrong-operation" }, { tool: "create.event" }, { status: "executed" }, { requires_confirmation: false },
        { requires_approval: true }, { requires_reauth: "false" }, { requires_reauth: true }, { version: 1 },
        { preview: "HIDDEN" }, { items: [] }].map(extra => ({ ...fullAction().provider_receipt, ...extra }))];
    for (const [read, receipts] of [[true, invalidQueries], [false, invalidProposals]]) for (const provider_receipt of receipts) {
      let dispatches = 0;
      await assert.rejects(projected({
        catalog: async () => [capability(read ? "search.projects" : "create.task", read ? "read" : "execute")],
        query: async () => ({ ...fullQuery(), provider_receipt }), propose: async () => ({ ...fullAction(), provider_receipt }),
        completeTurn: async () => ({ content: "", tool_calls: [call('receipt_' + ++dispatches, read ? "query_search_projects" : "propose_create_task")] }),
      }), error => error.details?.reason === "provider_receipt_format");
      assert.equal(dispatches, 1);
    }
    for (const tool of readNames.slice(2)) {
      let dispatches = 0;
      await assert.rejects(projected({
        catalog: async () => [capability(tool)],
        query: async () => ({ ...fullQuery(tool), provider_receipt: { ...receipt(tool), items: [{ id: "private-id" }] } }),
        propose: async () => assert.fail("Read only"),
        completeTurn: async () => ({ content: "", tool_calls: [call('forbidden_ids_' + ++dispatches, 'query_' + tool.replaceAll('.', '_'))] }),
      }), error => error.details?.reason === "provider_receipt_format");
      assert.equal(dispatches, 1);
    }
  });

  it("accepts parent-contract optional receipt metadata without fabricating withheld facts", async () => {
    for (const provider_receipt of [
      { kind: "protected_query", tool: "search.projects", status: "protected_result" },
      { kind: "protected_query", tool: "search.projects", status: "protected_result", items: [{ id: "entity-1" }] },
    ]) {
      let dispatches = 0;
      const result = await projected({
        catalog: async () => [capability("search.projects")], query: async () => ({ ...fullQuery(), provider_receipt }),
        propose: async () => assert.fail("Read only"),
        completeTurn: async options => {
          if (++dispatches === 1) return { content: "", tool_calls: [call("optional", "query_search_projects")] };
          assert.deepEqual(JSON.parse(options.messages.find(message => message.role === "tool").content), provider_receipt);
          return { content: "Displayed in app.", tool_calls: [] };
        },
      });
      assert.equal(result.protected_results[0].status, "protected");
    }
  });

  it("keeps full and model-sent classifications independent and monotonic", async () => {
    for (const initial of [
      ...["confidential", "sensitive", "future-class", "personal", "public"].map(classification => ({ classification, messages: [] })),
      { classification: "public", messages: [{ role: "user", content: "password=initial-history-sentinel" }] },
      { classification: "public", messages: [{ role: "user", content: "History", classification: "confidential" }] },
    ]) {
      const initialClass = providers.classifyAgentContent(initial.messages, initial.classification);
      const classes = [];
      let queries = 0;
      const result = await projected({
        catalog: async () => [capability("search.projects")],
        query: async () => ({ ...fullQuery(), classification: ++queries === 1 ? "confidential" : "public" }),
        propose: async () => assert.fail("Read only"),
        completeTurn: async options => {
          classes.push(options.classification);
          return classes.length < 3 ? { content: "", tool_calls: [call('monotonic_' + classes.length, "query_search_projects")] }
            : { content: "Displayed in app.", tool_calls: [] };
        },
      }, initial);
      const sentClass = initialClass === "public" ? "internal" : initialClass;
      assert.deepEqual(classes, [initialClass, sentClass, sentClass]);
      assert.equal(result.classification, "confidential"); assert.equal(result.content_classification, sentClass);
      assert.deepEqual(result.protected_results.map(item => item.classification), ["confidential", "public"]);
    }
  });

  it("does not launder initial confidential history onto cloud without a local adapter", async () => {
    const localUrl = providers.REGISTRY.ollama.baseUrl;
    providers.REGISTRY.ollama.baseUrl = "";
    const start = requests.length;
    try {
      await assert.rejects(projected({
        catalog: async () => [], query: async () => assert.fail("No query"), propose: async () => assert.fail("No proposal"),
        completeTurn: options => providers.completeTurn(options, "external", providers.openRouterForKey("synthetic-projection-key")),
      }, { classification: "confidential" }), error => error.details?.reason === "provider_unavailable");
      assert.equal(requests.length, start);
    } finally { providers.REGISTRY.ollama.baseUrl = localUrl; }
  });

  it("retains local or absent-policy full results and ignores policy in run inputs", async () => {
    for (const policy of [undefined, "local"]) {
      const start = requests.length;
      let round = 0;
      const view = fullQuery();
      respond = (body, res) => {
        if (++round === 1) return reply(res, null, [call("local_full", "query_search_projects")]);
        assert.deepEqual(JSON.parse(body.messages.find(message => message.role === "tool").content), view);
        return reply(res, "Local observation verified.");
      };
      const result = await projected({
        catalog: async () => [capability("search.projects")], query: async () => view,
        propose: async () => assert.fail("Read only"),
        completeTurn: options => providers.completeTurn(options, "external", providers.openRouterForKey("synthetic-projection-key")),
      }, { protectedResultPolicy: "ui_only" }, { ...context, protectedResultPolicy: policy });
      assert.deepEqual(requests.slice(start).map(request => request.path), ["/external/chat/completions", "/local/v1/chat/completions"]);
      assert.equal(result.classification, "confidential"); assert.equal(result.content_classification, "confidential");
      assert.deepEqual(result.protected_results, []);
    }
  });

  it("invokes the scoped consent guard again for newly observed personal evidence", async () => {
    const personalContext = { ...context, knowledgeMode: "personal" };
    const start = requests.length;
    let guards = 0;
    let sharedSignal;
    respond = (_body, res) => reply(res, null, [call("personal_result", "query_search_projects")]);
    await assert.rejects(loop.runAgent(personalContext, {
      run_id: "consent-run", conversation_id: "personal-conversation", classification: "internal",
      messages: [{ role: "user", content: "Find the permitted project." }],
    }, {
      catalog: async () => [capability("search.projects")],
      query: async ctx => {
        assert.equal(ctx.knowledgeMode, "personal");
        return { result: { fact: "PRIVATE_SOURCE_SENTINEL" }, evidence: [{ id: "private-1", version: 2 }],
          classification: "personal", truncated: false };
      },
      propose: async () => assert.fail("No business mutation is authorized"),
      completeTurn: async options => {
        guards += 1;
        if (guards === 1) sharedSignal = options.signal;
        assert.equal(options.signal, sharedSignal);
        if (options.messages.some(message => message.role === "tool")) {
          assert.equal(options.classification, "personal");
          const source = JSON.parse(options.messages.find(message => message.role === "tool").content);
          assert.equal(source.evidence[0].version, 2);
          throw Object.assign(new Error("Personal source requires explicit scoped consent"), { code: "PERMISSION_DENIED" });
        }
        return providers.completeTurn(options, "external", providers.openRouterForKey("synthetic-consent-key"));
      },
    }), error => error.code === "PERMISSION_DENIED");
    assert.equal(guards, 2);
    assert.equal(requests.length, start + 1);
    assert.ok(!JSON.stringify(requests.slice(start)).includes("PRIVATE_SOURCE_SENTINEL"));
  });
});
