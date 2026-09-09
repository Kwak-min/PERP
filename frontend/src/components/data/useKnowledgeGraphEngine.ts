import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { isOrbitControls, isRenderLink, isRenderNode, type ActiveGraph, type GraphEngineController, type GraphEngineRequest, type OrbitControls, type StageGraph } from "./knowledgeGraphRuntime.ts";
import { prepareKnowledgeGraph, relationClass, type KnowledgeGraphStageNode } from "./knowledgeGraphStageModel.ts";

export function useKnowledgeGraphEngine(request: GraphEngineRequest): GraphEngineController {
  const { data, scopeKey, reducedMotion, onNodeSelect } = request;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<ActiveGraph | null>(null);
  const callbackRef = useRef(onNodeSelect);
  const selectedRef = useRef<string | null>(null);
  const hoveredRef = useRef("");
  const [autoRotate, setAutoRotate] = useState(!reducedMotion);
  const [engineState, setEngineState] = useState<GraphEngineController["engineState"]>(data.nodes.length === 0 ? "empty" : "loading");
  const [renderState, setRenderState] = useState<GraphEngineController["renderState"]>("idle");
  const [selectedRendererId, setSelectedRendererId] = useState<string | null>(null);
  const [hoveredTitle, setHoveredTitle] = useState("");
  const spinRef = useRef(autoRotate && !reducedMotion);

  useEffect(() => { callbackRef.current = onNodeSelect; }, [onNodeSelect]);
  useEffect(() => {
    if (reducedMotion) {
      spinRef.current = false;
      setAutoRotate(false);
    }
  }, [reducedMotion]);

  const paint = useCallback((): void => {
    const active = activeRef.current;
    if (active) active.graph.renderer().render(active.graph.scene(), active.graph.camera());
  }, []);

  const focusNode = useCallback((rendererId: string): void => {
    const active = activeRef.current;
    const node = active?.nodes.get(rendererId);
    if (!active || !node) return;
    const x = typeof node.x === "number" ? node.x : 0;
    const y = typeof node.y === "number" ? node.y : 0;
    const z = typeof node.z === "number" ? node.z : 0;
    const distance = Math.hypot(x, y, z);
    const ratio = distance > 0 ? 1 + 90 / distance : 1;
    const transition = reducedMotion || !spinRef.current ? 0 : 240;
    active.graph.cameraPosition(distance > 0 ? { x: x * ratio, y: y * ratio, z: z * ratio } : { x: 0, y: 0, z: 90 }, { x, y, z }, transition);
    if (transition === 0) paint();
  }, [paint, reducedMotion]);

  const selectNode = useCallback((node: KnowledgeGraphStageNode): void => {
    selectedRef.current = node.renderer_id;
    setSelectedRendererId(node.renderer_id);
    callbackRef.current?.(node);
    focusNode(node.renderer_id);
    activeRef.current?.graph.refresh();
  }, [focusNode]);

  // OrbitControls disconnects from domElement.getRootNode(). Layout cleanup must
  // dispose the engine before React detaches that root (including StrictMode replay).
  useLayoutEffect(() => {
    const host = hostRef.current;
    selectedRef.current = null;
    hoveredRef.current = "";
    setSelectedRendererId(null);
    setHoveredTitle("");
    if (!host || data.nodes.length === 0) {
      setEngineState("empty");
      setRenderState("idle");
      return;
    }

    let mounted = true;
    let observer: ResizeObserver | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let controls: OrbitControls | null = null;
    let controlRoot: Node | null = null;
    let graph: StageGraph | null = null;
    let renderOnce: (() => void) | null = null;
    let controlChange: (() => void) | null = null;
    const releaseGraph = (): void => {
      if (!mounted) return;
      // Retire callbacks before disposal, which can itself emit engine/context events.
      mounted = false;
      observer?.disconnect();
      canvas?.removeEventListener("webglcontextlost", fail);
      if (renderOnce) {
        canvas?.removeEventListener("pointermove", renderOnce);
        canvas?.removeEventListener("pointerdown", renderOnce);
      }
      if (controls) {
        if (controlChange) controls.removeEventListener("change", controlChange);
        // Three 0.185.1 disconnect/dispose omits the transient held-Control keyup.
        // Remove only this instance's listener from its original connected root;
        // a later real keyup would otherwise target the detached controls element.
        controlRoot?.removeEventListener("keyup", controls._interceptControlUp, { capture: true });
      }
      if (graph) {
        const current = activeRef.current;
        if (current?.graph === graph && current.wakeFrame) cancelAnimationFrame(current.wakeFrame);
        const renderer = graph.renderer();
        if (current?.graph === graph) activeRef.current = null;
        graph._destructor();
        if (!renderer.getContext().isContextLost()) renderer.forceContextLoss();
        graph = null;
      }
      host.replaceChildren();
    };
    const fail = (): void => {
      if (!mounted) return;
      releaseGraph();
      hoveredRef.current = "";
      setHoveredTitle("");
      setEngineState("error");
      setRenderState("idle");
    };
    const prepared = prepareKnowledgeGraph(data);
    const renderNodes = new Map(prepared.nodes.map((node) => [node.render_id, node]));
    setEngineState("loading");
    setRenderState("active");

    void import("3d-force-graph").then((module) => {
      if (!mounted) return;
      const instance = new module.default(host, { controlType: "orbit", rendererConfig: { alpha: true, antialias: true } });
      graph = instance;
      const instanceCanvas: HTMLCanvasElement = instance.renderer().domElement;
      canvas = instanceCanvas;
      instanceCanvas.addEventListener("webglcontextlost", fail);
      const candidateControls = instance.controls();
      if (!isOrbitControls(candidateControls)) throw new TypeError("Pinned graph engine did not provide OrbitControls");
      controls = candidateControls;
      controlRoot = controls.domElement.getRootNode();
      controls.autoRotate = spinRef.current;
      controls.autoRotateSpeed = 0.45;
      const computed = getComputedStyle(host);
      const colors = {
        ai: computed.getPropertyValue("--of-graph-ai").trim(), document: computed.getPropertyValue("--of-graph-document").trim(),
        hover: computed.getPropertyValue("--of-graph-hover").trim(), note: computed.getPropertyValue("--of-graph-note").trim(),
        selected: computed.getPropertyValue("--of-graph-selected").trim(), space: computed.getPropertyValue("--of-graph-space").trim(),
        wiki: computed.getPropertyValue("--of-graph-wiki").trim(),
      };
      const current: ActiveGraph = { graph: instance, controls: candidateControls, nodes: renderNodes, settled: false, wakeFrame: 0 };
      activeRef.current = current;
      renderOnce = (): void => {
        if (!mounted || spinRef.current || !current.settled) return;
        instance.resumeAnimation();
        if (current.wakeFrame) cancelAnimationFrame(current.wakeFrame);
        current.wakeFrame = requestAnimationFrame(() => {
          current.wakeFrame = 0;
          if (mounted && !spinRef.current) {
            instance.pauseAnimation();
            setRenderState("idle");
          }
        });
      };
      controlChange = (): void => { if (mounted && current.settled && !spinRef.current) paint(); };
      controls.addEventListener("change", controlChange);
      instance.width(Math.max(1, host.clientWidth)).height(Math.max(1, host.clientHeight)).backgroundColor("rgba(0,0,0,0)")
        .showNavInfo(false).nodeId("render_id").linkSource("render_source").linkTarget("render_target")
        .nodeLabel(() => "").linkLabel(() => "")
        .nodeVal((node) => isRenderNode(node) && node.kind === "space" ? 9 : 5)
        .nodeColor((node) => {
          if (!isRenderNode(node)) return colors.document;
          if (node.render_id === selectedRef.current) return colors.selected;
          if (node.title === hoveredRef.current && hoveredRef.current) return colors.hover;
          if (node.kind === "space") return colors.space;
          return node.kind === "note" ? colors.note : colors.document;
        })
        .nodeOpacity(0.94).linkColor((link) => isRenderLink(link) ? colors[relationClass(link.kind)] : colors.wiki)
        .linkWidth((link) => isRenderLink(link) && relationClass(link.kind) === "ai" ? 1.7 : 1.1)
        .linkOpacity(0.72).linkCurvature("curvature")
        .linkDirectionalArrowLength((link) => isRenderLink(link) && relationClass(link.kind) === "space" ? 3.5 : 5)
        .linkDirectionalArrowRelPos(0.83).enableNodeDrag(false)
        .warmupTicks(0).cooldownTicks(reducedMotion ? 0 : 120)
        .onNodeHover((node) => {
          if (!mounted) return;
          const title = node && isRenderNode(node) ? prepared.identityMap.get(node.render_id)?.title ?? "" : "";
          hoveredRef.current = title;
          setHoveredTitle(title);
          instance.refresh();
        })
        .onNodeClick((node) => {
          if (!mounted || !isRenderNode(node)) return;
          const original = prepared.identityMap.get(node.render_id);
          if (original) selectNode(original);
        })
        .onEngineTick(() => { if (mounted && !reducedMotion) setEngineState("ready"); })
        .onEngineStop(() => {
          if (!mounted) return;
          current.settled = true;
          if (!reducedMotion) setEngineState("ready");
          if (!spinRef.current) {
            instance.pauseAnimation();
            if (!reducedMotion) setRenderState("idle");
          }
        }).graphData({ nodes: prepared.nodes, links: prepared.links });
      if (renderOnce) {
        canvas?.addEventListener("pointermove", renderOnce, { passive: true });
        canvas?.addEventListener("pointerdown", renderOnce, { passive: true });
      }
      observer = new ResizeObserver(() => {
        if (!mounted) return;
        instance.width(Math.max(1, host.clientWidth)).height(Math.max(1, host.clientHeight));
        if (current.settled && !spinRef.current) paint();
      });
      observer.observe(host);
      if (reducedMotion) {
        current.settled = true;
        current.wakeFrame = requestAnimationFrame(() => {
          current.wakeFrame = requestAnimationFrame(() => {
            current.wakeFrame = 0;
            if (!mounted) return;
            instance.pauseAnimation();
            instance.zoomToFit(0, 48);
            paint();
            setEngineState("ready");
            setRenderState("idle");
          });
        });
      } else {
        setEngineState("ready");
        setRenderState("active");
      }
    }).catch(fail);

    return releaseGraph;
  }, [data, paint, reducedMotion, scopeKey, selectNode]);

  useEffect(() => {
    const active = activeRef.current;
    const spinning = autoRotate && !reducedMotion;
    spinRef.current = spinning;
    if (!active) return;
    active.controls.autoRotate = spinning;
    active.controls.update();
    if (spinning) {
      active.graph.resumeAnimation();
      setRenderState("active");
    } else if (active.settled) {
      active.graph.pauseAnimation();
      paint();
      setRenderState("idle");
    }
  }, [autoRotate, paint, reducedMotion]);

  const moveCamera = (angle: number, zoom: number): void => {
    const active = activeRef.current;
    if (!active) return;
    const camera = active.graph.cameraPosition();
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const transition = reducedMotion || !spinRef.current ? 0 : 240;
    active.graph.cameraPosition({ x: (camera.x * cosine + camera.z * sine) * zoom, y: camera.y * zoom, z: (camera.z * cosine - camera.x * sine) * zoom }, { x: 0, y: 0, z: 0 }, transition);
    if (transition === 0) paint();
  };
  const fit = (): void => {
    activeRef.current?.graph.zoomToFit(reducedMotion || !spinRef.current ? 0 : 240, 48);
    if (!spinRef.current) paint();
  };
  return { hostRef, engineState, renderState, autoRotate, selectedRendererId, hoveredTitle, selectNode, moveCamera, fit, toggleAutoRotate: () => setAutoRotate((current) => !current) };
}
