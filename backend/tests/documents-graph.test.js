import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { api, createOwnerOrg, startTestServer } from "./http.js";

// 조직 지식(RAG) 그래프: 공간을 허브로, 문서를 노드로, [[제목]] 위키링크를 간선으로 준다.
describe("organization knowledge graph", () => {
  let server;
  let owner;

  before(async () => {
    server = await startTestServer();
    owner = await createOwnerOrg(server.baseUrl, ["documents"]);
  });

  after(async () => {
    await server.close();
  });

  it("공간·문서·위키링크를 그래프로 돌려준다", async () => {
    const space = await api(server.baseUrl, "/documents/spaces", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { name: "운영 위키" },
    });
    assert.equal(space.status, 201, JSON.stringify(space.body));

    const hub = await api(server.baseUrl, "/documents", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: {
        title: "온보딩 가이드",
        content: "신규 입사자는 [[보안 정책]] 을 먼저 읽는다.",
        space_id: space.body.id,
        tags: ["온보딩"],
      },
    });
    assert.equal(hub.status, 201, JSON.stringify(hub.body));

    const policy = await api(server.baseUrl, "/documents", {
      method: "POST",
      token: owner.token,
      orgId: owner.orgId,
      body: { title: "보안 정책", content: "비밀은 Vault 에 두지 않는다.", space_id: space.body.id },
    });
    assert.equal(policy.status, 201, JSON.stringify(policy.body));

    const graph = await api(server.baseUrl, "/documents/graph", {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(graph.status, 200, JSON.stringify(graph.body));

    const spaceNode = graph.body.nodes.find((n) => n.id === space.body.id);
    assert.ok(spaceNode, "공간이 허브 노드로 있어야 한다");
    assert.equal(spaceNode.kind, "space");

    const hubNode = graph.body.nodes.find((n) => n.id === hub.body.id);
    assert.ok(hubNode, "문서가 노드로 있어야 한다");
    assert.equal(hubNode.kind, "document");
    assert.equal(hubNode.folder, "운영 위키", "문서는 공간 이름으로 묶인다");
    assert.ok(hubNode.chunks >= 1, "RAG 청크 수가 실려야 한다");

    const membership = graph.body.edges.filter((e) => e.kind === "space");
    assert.equal(membership.length, 2, "문서 2건이 공간에 연결되어야 한다");

    const wikilink = graph.body.edges.find((e) => e.kind === "link");
    assert.ok(wikilink, "[[보안 정책]] 위키링크가 간선이 되어야 한다");
    assert.equal(wikilink.source, hub.body.id);
    assert.equal(wikilink.target_id, policy.body.id);

    assert.equal(graph.body.stats.documents, 2);
    assert.equal(graph.body.stats.spaces, 1);
  });

  it("다른 조직의 문서는 그래프에 섞이지 않는다", async () => {
    const stranger = await createOwnerOrg(server.baseUrl, ["documents"]);
    await api(server.baseUrl, "/documents", {
      method: "POST",
      token: stranger.token,
      orgId: stranger.orgId,
      body: { title: "남의 조직 문서", content: "비밀" },
    });

    const graph = await api(server.baseUrl, "/documents/graph", {
      token: owner.token,
      orgId: owner.orgId,
    });
    assert.equal(graph.status, 200);
    assert.ok(
      !graph.body.nodes.some((n) => n.title === "남의 조직 문서"),
      "테넌트 경계를 넘으면 안 된다",
    );
  });
});
