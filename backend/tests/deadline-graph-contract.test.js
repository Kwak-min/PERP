import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";

import { db } from "../src/config/db.js";
import { graphIdentity } from "../src/services/graph-identity.service.js";
import { api, createOwnerOrg, startTestServer } from "./http.js";
import { startPgDocumentFixture } from "./pg-document-fixture.js";

const request = (server, actor, route, options = {}) => api(server.baseUrl, route, {
  token: actor.token,
  orgId: actor.orgId,
  ...options,
});

test("graph identity rejects missing and invalid opaque values before string conversion", () => {
  const base = { store: "pg", owner: "101", kind: "note" };
  for (const opaqueId of [undefined, null, false, true, {}, [], NaN, Infinity, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, "", "   "]) {
    assert.throws(() => graphIdentity({ ...base, opaqueId }), TypeError, `invalid ${String(opaqueId)}`);
  }
  assert.equal(graphIdentity({ ...base, opaqueId: "9007199254740993" }).opaque_id, "9007199254740993");
});

describe("legacy graph identity, resolution and document version contracts", () => {
  test("stored empty and malformed explicit bindings never reconnect to a matching title over HTTP", async () => {
    const server = await startTestServer();
    try {
      const owner = await createOwnerOrg(server.baseUrl, ["agent"]);
      const source = await request(server, owner, "/vault/notes", {
        method: "POST", body: { title: "Source", content: "[[Target]]", agent_enabled: false },
      });
      const target = await request(server, owner, "/vault/notes", {
        method: "POST", body: { title: "Target", content: "", agent_enabled: false },
      });
      assert.equal(source.status, 201);
      assert.equal(target.status, 201);
      for (const targetId of [null, "", " ", "malformed-explicit-id", "0", null]) {
        const updated = db().prepare("UPDATE vault_link SET target_id = ? WHERE source_id = ?").run(targetId, source.body.id);
        assert.equal(updated.changes, 1);
        assert.equal(db().prepare("SELECT target_id FROM vault_link WHERE source_id = ?").get(source.body.id).target_id, targetId);
        const graph = await request(server, owner, "/vault/graph");
        assert.equal(graph.status, 200, JSON.stringify(graph.body));
        const declared = graph.body.edges.find(edge => edge.source === source.body.id);
        assert.ok(declared);
        if (targetId === null) {
          const targetNode = graph.body.nodes.find(node => node.id === target.body.id);
          assert.equal(declared.binding, "title");
          assert.equal(declared.resolution, "resolved");
          assert.equal(declared.target_id, target.body.id);
          assert.equal(declared.target_renderer_id, targetNode.renderer_id);
        } else {
          assert.equal(declared.binding, "explicit", `stored ${JSON.stringify(targetId)} must not become a title declaration`);
          assert.equal(declared.resolution, "unresolved");
          assert.equal(declared.resolution_reason, "malformed_target_id");
          assert.equal(declared.target_id, null);
          assert.equal(declared.target_renderer_id, null);
        }
      }
    } finally {
      await server.close();
    }
  });

  test("HTTP graph resolution is explicit, title declarations recalculate, and document PATCH is versioned", async () => {
    const server = await startTestServer();
    try {
      const owner = await createOwnerOrg(server.baseUrl, ["agent", "documents"]);
      const source = await request(server, owner, "/vault/notes", {
        method: "POST",
        body: { title: "Source", content: "[[Target]]", folder: "/" },
      });
      assert.equal(source.status, 201, JSON.stringify(source.body));
      const target = await request(server, owner, "/vault/notes", {
        method: "POST",
        body: { title: "Target", content: "", folder: "/" },
      });
      assert.equal(target.status, 201, JSON.stringify(target.body));

      let graph = await request(server, owner, "/vault/graph");
      assert.equal(graph.status, 200, JSON.stringify(graph.body));
      const sourceNode = graph.body.nodes.find((node) => node.id === source.body.id);
      const targetNode = graph.body.nodes.find((node) => node.id === target.body.id);
      assert.deepEqual(sourceNode.identity, {
        store: "legacy", company: owner.orgId, owner: owner.userId, kind: "note", opaque_id: source.body.id,
      });
      assert.notEqual(sourceNode.renderer_id, targetNode.renderer_id);
      let declared = graph.body.edges.find((item) => item.source === source.body.id);
      assert.equal(declared.binding, "title");
      assert.equal(declared.resolution, "resolved");
      assert.equal(declared.target_renderer_id, targetNode.renderer_id);

      const renamed = await request(server, owner, `/vault/notes/${target.body.id}`, {
        method: "PATCH",
        body: { version: target.body.version, title: "Renamed" },
      });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      graph = await request(server, owner, "/vault/graph");
      declared = graph.body.edges.find((item) => item.source === source.body.id);
      assert.equal(declared.resolution, "unresolved", "title declaration is recalculated rather than permanently rebound");
      assert.equal(declared.target_id, null);
      assert.equal(declared.target_renderer_id, null);

      const restored = await request(server, owner, `/vault/notes/${target.body.id}`, {
        method: "PATCH",
        body: { version: renamed.body.version, title: "Target" },
      });
      assert.equal(restored.status, 200);
      db().prepare("UPDATE vault_link SET target_id = ? WHERE source_id = ?").run(randomUUID(), source.body.id);
      graph = await request(server, owner, "/vault/graph");
      declared = graph.body.edges.find((item) => item.source === source.body.id);
      assert.equal(declared.binding, "explicit");
      assert.equal(declared.resolution, "unavailable");
      assert.equal(declared.target_id, null, "stale explicit ID cannot fall back to the matching title");
      assert.equal(declared.target_renderer_id, null);
      db().prepare("UPDATE vault_link SET target_id = ? WHERE source_id = ?").run("malformed-explicit-id", source.body.id);
      graph = await request(server, owner, "/vault/graph");
      declared = graph.body.edges.find((item) => item.source === source.body.id);
      assert.equal(declared.resolution, "unresolved");
      assert.equal(declared.resolution_reason, "malformed_target_id");
      assert.equal(declared.target_id, null);

      const document = await request(server, owner, "/documents", {
        method: "POST",
        body: { title: "Versioned document", content: "initial" },
      });
      assert.equal(document.status, 201);
      const blind = await request(server, owner, `/documents/${document.body.id}`, {
        method: "PATCH",
        body: { content: "blind" },
      });
      assert.equal(blind.status, 400);
      const saved = await request(server, owner, `/documents/${document.body.id}`, {
        method: "PATCH",
        body: { content: "saved", version: document.body.version },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.version, document.body.version + 1);
      const stale = await request(server, owner, `/documents/${document.body.id}`, {
        method: "PATCH",
        body: { content: "overwrite", version: document.body.version },
      });
      assert.equal(stale.status, 409);
      assert.equal((await request(server, owner, `/documents/${document.body.id}`)).body.content, "saved");
    } finally {
      await server.close();
    }
  });
});

describe("PG company graph and generic document version contracts", () => {
  test("typed project hubs remain distinct and generic PATCH requires and returns the scoped version", async () => {
    const fixture = await startPgDocumentFixture();
    try {
      await fixture.engine.query("UPDATE project.projects SET name='Duplicate project' WHERE id IN (10,11)");
      const graph = await request(fixture, fixture.actors.writer, "/pg/documents/graph");
      assert.equal(graph.status, 200, JSON.stringify(graph.body));
      const hub = graph.body.nodes.find((node) => node.kind === "space" && node.identity.opaque_id === "10");
      const document = graph.body.nodes.find((node) => node.kind === "document" && node.id === "1");
      assert.ok(hub && document);
      assert.notEqual(hub.renderer_id, document.renderer_id);
      assert.deepEqual(hub.identity, { store: "pg", company: "77", owner: null, kind: "space", opaque_id: "10" });
      const membership = graph.body.edges.find((edge) => edge.kind === "space" && edge.source === document.id);
      assert.equal(membership.resolution, "resolved");
      assert.equal(membership.target_renderer_id, hub.renderer_id);

      const foreign = await request(fixture, fixture.actors.foreign, "/pg/records/documents/1", {
        method: "PATCH", body: { content_md: "foreign blind write" },
      });
      assert.equal(foreign.status, 404, "scope authorization precedes malformed version disclosure");
      const detail = await request(fixture, fixture.actors.writer, "/pg/records/documents/1");
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      assert.equal(detail.body.id, "1");
      assert.equal(detail.body.version, 1);
      const blind = await request(fixture, fixture.actors.writer, "/pg/records/documents/1", {
        method: "PATCH", body: { content_md: "blind" },
      });
      assert.equal(blind.status, 400);
      const saved = await request(fixture, fixture.actors.writer, "/pg/records/documents/1", {
        method: "PATCH", body: { content_md: "saved", version: detail.body.version },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.version, 2);
      const stale = await request(fixture, fixture.actors.writer, "/pg/records/documents/1", {
        method: "PATCH", body: { content_md: "overwrite", version: detail.body.version },
      });
      assert.equal(stale.status, 409);
      assert.equal((await request(fixture, fixture.actors.writer, "/pg/documents/1")).body.content, "saved");
      assert.deepEqual((await fixture.engine.query('SELECT revision,content FROM workspace.document_versions WHERE document_id=1 ORDER BY revision')).rows,
        [{revision:1,content:'SYNTH_RELATED pglaunch'},{revision:2,content:'saved'}]);
    } finally {
      await fixture.close();
    }
  });
});
