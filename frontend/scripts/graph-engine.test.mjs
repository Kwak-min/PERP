import assert from "node:assert/strict";
import { test } from "node:test";
import { ALPHA_MIN, buildScene, boundingRadius, fitDistance, pickNode, projectScene, projected, screenRadius, stepScene } from "../src/screens/vault/graph3d.ts";

const graph = (count, edges = []) => ({ nodes: Array.from({ length: count }, (_, i) => ({ id: String(i), title: `Note ${i}`, folder: `/folder-${i % 4}` })), edges, orphans: [] });
const settle = (scene) => { while (scene.alpha > ALPHA_MIN) stepScene(scene); };

test("repulsion magnitude is k squared / distance, with symmetric forces", () => {
  // Given two unlinked nodes at a known distance; When stepping; Then inspect force before cooling/clamping.
  const scene = buildScene(graph(2));
  scene.pos.set([0, 0, 0, 100, 0, 0]);
  stepScene(scene);
  assert.ok(Math.abs(scene.disp[0] + scene.k ** 2 / 100) < 0.0001, `force=${scene.disp[0]}, expected=${-(scene.k ** 2) / 100}`);
  assert.equal(scene.disp[0], -scene.disp[3]);
});

test("a singleton starts at the origin", () => {
  const scene = buildScene(graph(1));
  assert.deepEqual([...scene.pos], [0, 0, 0]);
});

test("zoom cannot move the camera inside the graph and produce false near-plane nodes", () => {
  const scene = buildScene(graph(2));
  scene.pos.set([0, 0, -500, 10, 0, 500]);
  const camera = { yaw: 0, pitch: 0, distance: 160 };
  projectScene(scene, camera, 600, 500);
  assert.ok(camera.distance >= boundingRadius(scene) + 40, `distance=${camera.distance}`);
  assert.ok(projected(scene, 0, 2) >= 40);
  assert.ok(projected(scene, 1, 2) > projected(scene, 0, 2));
});

test("fit accounts for narrow viewport and includes every node with padding", () => {
  const scene = buildScene(graph(1000));
  projectScene(scene, { yaw: 0, pitch: 0, distance: 900 }, 280, 420);
  const camera = { yaw: 0.6, pitch: 0.35, distance: fitDistance(scene) };
  projectScene(scene, camera, 280, 420);
  for (let i = 0; i < scene.count; i++) {
    const x = projected(scene, i, 0), y = projected(scene, i, 1), r = screenRadius(scene, i);
    assert.ok(x - r >= 16 && x + r <= 264 && y - r >= 16 && y + r <= 404, `node ${i}: ${x},${y} r=${r}`);
  }
});

test("stale explicit IDs and ambiguous titles do not invent links", () => {
  const data = graph(3, [
    { source: "0", target_id: "deleted", target_title: "Note 1" },
    { source: "0", target_id: null, target_title: "duplicate" },
  ]);
  data.nodes[1].title = data.nodes[2].title = "duplicate";
  const scene = buildScene(data);
  assert.equal(scene.linkCount, 0);
  assert.equal(scene.unresolved, 2);
});

test("case-folded duplicate PG titles stay unresolved in the renderer", () => {
  const data=graph(3,[{source:"0",target_id:null,target_title:"Duplicate"}]);
  data.nodes[1].title="Duplicate";data.nodes[2].title="duplicate";
  const scene=buildScene(data);
  assert.equal(scene.linkCount,0);
  assert.equal(scene.unresolved,1);
});

for (const count of [0, 1, 2, 20, 1000]) test(`disconnected ${count}-node layout settles deterministically and stays finite`, () => {
  const a = buildScene(graph(count)), b = buildScene(graph(count));
  settle(a); settle(b);
  assert.deepEqual(a.pos, b.pos);
  assert.ok([...a.pos].every(Number.isFinite));
  if (count > 2) assert.ok(new Set(Array.from({length: count}, (_, i) => a.pos[i * 3 + 2].toFixed(2))).size > 2);
});

test("linked notes remain legible at fit when an isolated note is present", () => {
  const scene = buildScene(graph(4, [
    {source:"0",target_id:"1",target_title:"Note 1"},
    {source:"1",target_id:"2",target_title:"Note 2"},
    {source:"2",target_id:"0",target_title:"Note 0"},
  ]));
  settle(scene);
  projectScene(scene,{yaw:0.6,pitch:0.35,distance:900},842,558);
  projectScene(scene,{yaw:0.6,pitch:0.35,distance:fitDistance(scene)},842,558);
  for(let i=0;i<3;i++) {
    assert.ok(projected(scene,i,3)>=0.3 && screenRadius(scene,i)>=7,`note ${i}: scale=${projected(scene,i,3)}, radius=${screenRadius(scene,i)}`);
    for(let j=i+1;j<3;j++) {
      const distance=Math.hypot(...[0,1,2].map(axis=>scene.pos[i*3+axis]-scene.pos[j*3+axis]));
      assert.ok(distance>=scene.k*0.6,`linked nodes ${i}/${j} collapsed: distance=${distance}`);
    }
  }
});

test("company hub links remain deduplicated and picking chooses nearest sphere", () => {
  const scene = buildScene(graph(3, [
    {source:"0",target_id:"1",target_title:"Note 1"},
    {source:"1",target_id:"0",target_title:"Note 0"},
    {source:"0",target_id:"2",target_title:"Note 2"},
  ]));
  assert.equal(scene.linkCount, 2);
  scene.pos.set([0,0,-100, 0,0,100, 100,0,0]);
  projectScene(scene, {yaw:0,pitch:0,distance:500}, 600, 500);
  assert.equal(pickNode(scene,300,250),0);
  assert.ok(screenRadius(scene,0)>screenRadius(scene,1));
});
