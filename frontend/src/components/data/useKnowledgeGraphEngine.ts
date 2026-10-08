import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NodeObject } from "3d-force-graph";

import { isOrbitControls, isRenderLink, isRenderNode, type ActiveGraph, type GraphEngineController, type GraphEngineRequest, type OrbitControls, type StageGraph } from "./knowledgeGraphRuntime.ts";
import { prepareKnowledgeGraph, relationClass, type KnowledgeGraphStageNode } from "./knowledgeGraphStageModel.ts";

export function useKnowledgeGraphEngine(request: GraphEngineRequest): GraphEngineController {
  const { data, scopeKey, reducedMotion, onNodeSelect, hiddenRelations } = request;
  const hiddenRef = useRef(hiddenRelations);
  hiddenRef.current = hiddenRelations;
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
    if (active) {
      active.graph.renderer().render(active.graph.scene(), active.graph.camera()); active.updateLabels();
      if (hostRef.current) {
        hostRef.current.dataset.paintedSize = `${active.graph.width()}:${active.graph.height()}`;
        hostRef.current.dataset.paintedAspect = String(active.graph.camera().aspect);
      }
    }
  }, []);

  const fitGraph = useCallback((graph: StageGraph, duration = 0): void => {
    if (graph.graphData().nodes.length === 1) {
      const camera = graph.cameraPosition(), ratio = 160 / Math.hypot(camera.x, camera.y, camera.z);
      graph.cameraPosition({ x: camera.x * ratio, y: camera.y * ratio, z: camera.z * ratio }, { x: 0, y: 0, z: 0 }, duration);
    } else graph.zoomToFit(duration, 48);
  }, []);

  const refreshGraph = useCallback((): void => {
    const active = activeRef.current;
    if (!active) return;
    // 색 갱신으로 mesh를 재생성하면 hover 직후 click의 raycast 대상이 사라진다.
    active.settled = false;
    active.graph.nodeColor(node => active.colorNode(node));
    active.graph.resumeAnimation();
    setRenderState("active");
  }, []);

  useEffect(() => {
    const active = activeRef.current;
    if (!active) return;
    active.graph.linkVisibility(link => !isRenderLink(link) || !hiddenRelations?.includes(link.kind));
    refreshGraph();
  }, [hiddenRelations, refreshGraph]);

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
    refreshGraph();
  }, [focusNode, refreshGraph]);

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

    let mounted = true, fitted = false, resizeFrame = false;
    let observer: ResizeObserver | null = null;
    let canvasSizeObserver: MutationObserver | null = null;
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
      canvasSizeObserver?.disconnect();
      canvas?.removeEventListener("webglcontextlost", fail);
      if (renderOnce) {
        host.removeEventListener("pointermove", renderOnce);
        host.removeEventListener("pointerdown", renderOnce);
        host.removeEventListener("pointerup", renderOnce);
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
        citation: computed.getPropertyValue("--of-graph-citation").trim(),
        derived: computed.getPropertyValue("--of-graph-derived").trim(),
      };
      const colorNode = (node: NodeObject): string => {
        if (!isRenderNode(node)) return colors.document;
        if (node.render_id === selectedRef.current) return colors.selected;
        if (node.title === hoveredRef.current && hoveredRef.current) return colors.hover;
        if (node.kind === "space" || node.kind === "source") return colors.space;
        if (node.kind === "concept" || node.kind === "note") return colors.note;
        if (node.kind === "entity") return colors.ai;
        return colors.document;
      };
      const labelLayer = document.createElement("div");
      labelLayer.className = "knowledge-graph-stage__labels";
      host.append(labelLayer);
      const labels = new Map<string, HTMLSpanElement>();
      const updateLabels = (): void => {
        if (!mounted) return;
        const priority = prepared.nodes.filter(node => node.render_id === selectedRef.current || node.title === hoveredRef.current);
        const candidates = [...new Map([...priority, ...prepared.nodes.slice(0, 40)].map(node => [node.render_id, node])).values()];
        for (const label of labels.values()) label.hidden = true;
        const occupied: { x: number; y: number; width: number; height: number }[] = [];
        for (const node of candidates) {
          const position = instance.graph2ScreenCoords(node.x ?? 0, node.y ?? 0, node.z ?? 0);
          if (position.x < 0 || position.y < 0 || position.x > host.clientWidth || position.y > host.clientHeight) continue;
          let label = labels.get(node.render_id);
          if (!label) {
            label = document.createElement("span"); label.className = "knowledge-graph-stage__label";
            label.textContent = node.title || "제목 없음"; label.dataset.rendererId = node.render_id;
            labelLayer.append(label); labels.set(node.render_id, label);
          }
          label.hidden = false;
          const width = label.offsetWidth, height = label.offsetHeight;
          const placements = ([[12, -height - 12], [-width - 12, -height - 12], [12, 12], [-width - 12, 12]] as const).map(([dx, dy]) => ({
            x: Math.max(4, Math.min(position.x + dx, host.clientWidth - width - 4)),
            y: Math.max(4, Math.min(position.y + dy, host.clientHeight - height - 36)), width, height,
          }));
          const placement = placements.find(({ x, y }) => !occupied.some(box => x < box.x + box.width + 4 && x + width + 4 > box.x && y < box.y + box.height + 4 && y + height + 4 > box.y));
          if (!placement) { label.hidden = true; continue; }
          label.style.transform = `translate(${placement.x}px, ${placement.y}px)`;
          occupied.push(placement);
        }
      };
      const current: ActiveGraph = { graph: instance, controls: candidateControls, nodes: renderNodes, updateLabels, colorNode, settled: false, wakeFrame: 0 };
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
      controlChange = (): void => { if (!mounted) return; if (current.settled && !spinRef.current) paint(); else updateLabels(); };
      controls.addEventListener("change", controlChange);
      instance.width(Math.max(1, host.clientWidth)).height(Math.max(1, host.clientHeight)).backgroundColor("rgba(0,0,0,0)")
        .showNavInfo(false).nodeId("render_id").linkSource("render_source").linkTarget("render_target")
        .linkVisibility(link => !isRenderLink(link) || !hiddenRef.current?.includes(link.kind))
        .nodeLabel(() => "").linkLabel(() => "")
        .nodeVal((node) => isRenderNode(node) && node.kind === "space" ? 9 : 5)
        .nodeColor(colorNode)
        .nodeOpacity(0.94).linkColor((link) => isRenderLink(link) ? colors[relationClass(link.kind)] : colors.wiki)
        .linkWidth((link) => isRenderLink(link) && relationClass(link.kind) === "ai" ? 1.7 : 1.1)
        .linkOpacity(0.72).linkCurvature("curvature")
        .linkDirectionalArrowLength((link) => isRenderLink(link) && link.direction === "undirected" ? 0 : isRenderLink(link) && relationClass(link.kind) === "space" ? 3.5 : 5)
        .linkDirectionalArrowRelPos(0.83).enableNodeDrag(false)
        .warmupTicks(reducedMotion ? 120 : 0).cooldownTicks(reducedMotion ? 0 : 120)
        .onNodeHover((node) => {
          if (!mounted) return;
          const title = node && isRenderNode(node) ? prepared.identityMap.get(node.render_id)?.title ?? "" : "";
          hoveredRef.current = title;
          setHoveredTitle(title);
          refreshGraph();
        })
        .onNodeClick((node) => {
          if (!mounted || !isRenderNode(node)) return;
          const original = prepared.identityMap.get(node.render_id);
          if (original) selectNode(original);
        })
        .onEngineTick(() => { if (mounted && !reducedMotion) { updateLabels(); setEngineState("ready"); } })
        .onEngineStop(() => {
          if (!mounted) return;
          // onEngineStop는 mesh 위치 반영 전이다. 해당 tick이 끝난 뒤 맞추고 멈춘다.
          queueMicrotask(() => {
            if (!mounted) return;
            current.settled = true;
            if (!fitted || resizeFrame) { if (resizeFrame || !selectedRef.current) fitGraph(instance); fitted = true; resizeFrame = false; }
            if (!spinRef.current) { instance.pauseAnimation(); setRenderState("idle"); }
            paint();
            setEngineState("ready");
          });
        }).graphData({ nodes: prepared.nodes, links: prepared.links });
      if (renderOnce) {
        // 엔진 내부 container가 pointer 좌표를 먼저 반영한 뒤 raycast를 깨운다.
        host.addEventListener("pointermove", renderOnce, { passive: true });
        host.addEventListener("pointerdown", renderOnce, { passive: true });
        host.addEventListener("pointerup", renderOnce, { passive: true });
      }
      // Kapsule applies width/height asynchronously. Repaint after the actual
      // drawing-buffer resize, not before the deferred update clears it.
      canvasSizeObserver = new MutationObserver(() => {
        if (!mounted || !current.settled) return;
        if (resizeFrame) { fitGraph(instance); resizeFrame = false; }
        paint();
      });
      canvasSizeObserver.observe(instanceCanvas, { attributes: true, attributeFilter: ["width", "height"] });
      observer = new ResizeObserver(() => {
        if (!mounted) return;
        const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
        if (instance.width() === width && instance.height() === height) return;
        resizeFrame = true;
        instance.width(width).height(height);
      });
      observer.observe(host);
      if (!reducedMotion) {
        setEngineState("ready");
        setRenderState("active");
      }
    }).catch(fail);

    return releaseGraph;
  }, [data, fitGraph, paint, reducedMotion, refreshGraph, scopeKey, selectNode]);

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
    if (activeRef.current) fitGraph(activeRef.current.graph, reducedMotion || !spinRef.current ? 0 : 240);
    if (!spinRef.current) paint();
  };
  return { hostRef, engineState, renderState, autoRotate, selectedRendererId, hoveredTitle, selectNode, moveCamera, fit, toggleAutoRotate: () => setAutoRotate((current) => !current) };
}
