import path from 'node:path';

// Test-only constructor tap, following Task27: instantiate the shipped engine,
// never replace its simulation, WebGL context, geometry, render or pick behavior.
export function nativeGraphObserver(root) {
  return {
    resolve: { alias: { 'native-actual-engine': path.join(root, 'node_modules/3d-force-graph/dist/3d-force-graph.mjs').replaceAll('\\', '/') } },
    optimizeDeps: { exclude: ['3d-force-graph'], include: ['native-actual-engine', 'three', 'react', 'react-dom/client', 'react-dom', 'zod'] },
    plugin: {
      name: 'native-graph-observer', enforce: 'pre',
      resolveId(id) { if (id === '3d-force-graph') return '\0native-graph-engine'; },
      load(id) {
        if (id === '\0native-graph-engine') return `import Actual from 'native-actual-engine';
          export default function Observed(...args) {
            const graph = new Actual(...args);
            window.__captureNativeGraph(graph);
            return graph;
          }`;
      },
    },
  };
}

export function instrumentNativeGraph() {
  const ready = Promise.withResolvers();
  window.__nativePaint = ready.promise;
  // Retain rejection for the caller without an unhandled-rejection page error.
  window.__nativePaint.catch(() => {});
  let current;
  const diagnostic = () => JSON.stringify({ expected: '3d-force-graph WebGL onEngineStop + rendered scene (not Canvas2D strokes)',
    stages: [...document.querySelectorAll('.knowledge-graph-stage')].map(s => ({ ...s.dataset })),
    captured: Boolean(current), generation: current?.generation, stopped: current?.stopped,
    context: current?.graph.renderer().getContext().constructor.name });
  const timer = setTimeout(() => ready.reject(new Error('Native graph renderer precondition/settled event failed: ' + diagnostic())), 10000);
  window.__captureNativeGraph = graph => {
    const rec = { graph, generation: 0, stopped: false, retired: false };
    current = rec;
    const renderer = graph.renderer(), gl = renderer.getContext();
    if (!renderer.isWebGLRenderer || !(gl instanceof WebGL2RenderingContext || gl instanceof WebGLRenderingContext)) {
      clearTimeout(timer); ready.reject(new Error('Native graph requires the actual WebGL renderer: ' + diagnostic())); return;
    }
    const data = graph.graphData;
    graph.graphData = function (...args) {
      if (args.length && args[0] !== data.call(this)) { rec.generation++; rec.stopped = false; }
      return data.apply(this, args);
    };
    const stop = graph.onEngineStop;
    graph.onEngineStop = function (...args) {
      if (!args.length) return stop.call(this);
      return stop.call(this, (...values) => {
        const value = args[0](...values);
        if (!rec.retired) rec.stopped = true;
        return value;
      });
    };
    const destroy = graph._destructor;
    graph._destructor = function (...args) { rec.retired = true; return destroy.apply(this, args); };
    const render = renderer.render;
    renderer.render = function (scene, camera) {
      const drawn = new Set(), restores = [];
      // Three's actual render callbacks certify mesh submission, not DTO/DOM counts.
      scene.traverse(object => {
        if (!object.isMesh) return;
        const after = object.onAfterRender;
        object.onAfterRender = function (...args) { drawn.add(object); return after.apply(this, args); };
        restores.push(() => { object.onAfterRender = after; });
      });
      let value;
      try { value = render.call(this, scene, camera); }
      finally { restores.forEach(restore => restore()); }
      if (current === rec && !rec.retired && rec.generation && rec.stopped) {
        clearTimeout(timer);
        const inScene = object => { for (let p = object; p; p = p.parent) if (p === scene) return true; return false; };
        const vector = (object, x, y, z) => object.localToWorld(object.position.clone().set(x, y, z)).toArray();
        const links = graph.graphData().links.map(link => {
          const line = link.__lineObj, arrow = link.__arrowObj;
          const point = t => line.geometry.parameters.path
            ? line.localToWorld(line.geometry.parameters.path.getPoint(t)).toArray()
            : vector(line, 0, 0, t);
          return { id: link.id, renderEdgeId: link.render_edge_id, source: link.source.id, target: link.target.id,
            sourceRendererId: link.source.render_id, targetRendererId: link.target.render_id,
            sourcePosition: ['x', 'y', 'z'].map(k => link.source[k] || 0), targetPosition: ['x', 'y', 'z'].map(k => link.target[k] || 0),
            declaration: link.declaration, kind: link.kind, binding: link.binding, resolution: link.resolution,
            geometry: line.geometry.type, vertices: line.geometry.attributes.position.count,
            start: point(0), midpoint: point(.5), end: point(1), drawn: drawn.has(line), attached: inScene(line),
            arrowLength: graph.linkDirectionalArrowLength()(link), arrowGeometry: arrow?.geometry.type,
            arrowHeight: arrow?.geometry.parameters.height, arrowVisible: arrow?.visible,
            arrowDrawn: drawn.has(arrow), arrowAttached: inScene(arrow),
            arrowTail: arrow ? vector(arrow, 0, 0, 0) : null, arrowHead: arrow ? vector(arrow, 0, 0, arrow.geometry.parameters.height) : null };
        });
        ready.resolve({ event: 'onEngineStop + WebGL render', generation: rec.generation, webgl: gl.constructor.name,
          contextLost: gl.isContextLost(), canvasConnected: renderer.domElement.isConnected,
          renderCalls: renderer.info.render.calls,
          nodes: graph.graphData().nodes.map(n => ({ id: n.id, rendererId: n.render_id, identity: n.identity,
            drawn: drawn.has(n.__threeObj), attached: inScene(n.__threeObj) })), links });
      }
      return value;
    };
  };
}
