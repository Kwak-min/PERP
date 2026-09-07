import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, userMessageOf } from "../services/api";
import { useSession } from "../store/session";
import { NoteEditor } from "./vault/NoteEditor";
import {
  ALPHA_MIN,
  buildScene,
  depthAlpha,
  fitDistance,
  folderPalette,
  graphSchema,
  lighten,
  linkEnds,
  orderAt,
  pickNode,
  projectScene,
  projected,
  screenRadius,
  stepScene,
  type Camera,
  type GraphNode,
  type Scene,
} from "./vault/graph3d";
import {
  EMPTY_DRAFT,
  draftOf,
  noteDetailSchema,
  noteSchema,
  tagsOf,
  type NoteDraft,
} from "./vault/model";

import "./vault.css";
import "./graph-stage.css";

type Pointer = { down: boolean; x: number; y: number; moved: number };

export function VaultGraphScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const cameraRef = useRef<Camera>({ yaw: 0.6, pitch: 0.35, distance: 900 });
  const nodesRef = useRef<readonly GraphNode[]>([]);
  const paletteRef = useRef<ReadonlyMap<string, string>>(new Map());
  const selectedRef = useRef<number>(-1);
  const hoverRef = useRef<number>(-1);
  const reducedMotion = useRef(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const spinRef = useRef<boolean>(!reducedMotion.current);
  const frameRef = useRef<number>(0);
  const fittedRef = useRef<boolean>(false);
  const pointerRef = useRef<Pointer>({ down: false, x: 0, y: 0, moved: 0 });
  const openRequest = useRef<AbortController | null>(null);
  const graphRequest = useRef<AbortController | null>(null);
  const mutationRequest = useRef<AbortController | null>(null);
  const selectionEpoch = useRef(0);
  const selectedId = useRef<string | null>(null);

  const [stats, setStats] = useState({ nodes: 0, links: 0, orphans: 0, unresolved: 0 });
  const [selected, setSelected] = useState<{ id: string; title: string; version: number } | null>(null);
  const [draft, setDraft] = useState<NoteDraft>(EMPTY_DRAFT);
  const [folders, setFolders] = useState<readonly string[]>([]);
  const [spin, setSpin] = useState(!reducedMotion.current);
  const [loadingNote, setLoadingNote] = useState(false);
  const [saving, setSaving] = useState(false);
  const [graphLoading, setGraphLoading] = useState(true);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [nodeOptions, setNodeOptions] = useState<readonly GraphNode[]>([]);
  const busy = loadingNote || saving;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apiSession = useMemo(
    () => (session?.orgId ? { token: session.token, orgId: session.orgId } : null),
    [session?.token, session?.orgId],
  );

  const vaultBase = session?.orgId?.startsWith("pg:") ? "/pg/vault" : "/vault";

  const draw = useCallback((): void => {
    const canvas = canvasRef.current;
    const scene = sceneRef.current;
    if (!canvas || !scene) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const ratio = window.devicePixelRatio || 1;
    const width = canvas.width / ratio;
    const height = canvas.height / ratio;
    const camera = cameraRef.current;

    projectScene(scene, camera, width, height);

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // 연결선 — 두 끝점 평균 깊이로 흐리게.
    ctx.lineWidth = 1;
    for (let l = 0; l < scene.linkCount; l += 1) {
      const [a, b] = linkEnds(scene, l);
      const near = selectedRef.current === a || selectedRef.current === b;
      const fog = (depthAlpha(scene, a, camera.distance) + depthAlpha(scene, b, camera.distance)) / 2;
      ctx.strokeStyle = near ? `rgba(79,70,229,${(0.55 + fog * 0.4).toFixed(3)})` : `rgba(100,116,139,${(fog * 0.32).toFixed(3)})`;
      ctx.lineWidth = near ? 1.8 : 1;
      ctx.beginPath();
      ctx.moveTo(projected(scene, a, 0), projected(scene, a, 1));
      ctx.lineTo(projected(scene, b, 0), projected(scene, b, 1));
      ctx.stroke();
    }

    // 노드 — 먼 것부터(화가 알고리즘). 본체 + 좌상단 하이라이트로 구체감을 낸다.
    const palette = paletteRef.current;
    for (let o = 0; o < scene.count; o += 1) {
      const i = orderAt(scene, o);
      const x = projected(scene, i, 0);
      const y = projected(scene, i, 1);
      const r = screenRadius(scene, i);
      const fog = depthAlpha(scene, i, camera.distance);
      const isSelected = selectedRef.current === i;
      const isHover = hoverRef.current === i;
      const base = palette.get(nodesRef.current[i]?.folder ?? "/") ?? "#4f46e5";

      ctx.globalAlpha = fog * 0.22;
      ctx.beginPath();
      ctx.ellipse(x, y + r * 0.95, r * 0.9, r * 0.32, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#0f172a";
      ctx.fill();

      ctx.globalAlpha = fog;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = base;
      ctx.fill();

      ctx.globalAlpha = fog * 0.55;
      ctx.beginPath();
      ctx.arc(x - r * 0.3, y - r * 0.34, r * 0.48, 0, Math.PI * 2);
      ctx.fillStyle = lighten(base, 0.75);
      ctx.fill();

      ctx.globalAlpha = Math.min(1, fog + 0.2);
      ctx.lineWidth = isSelected ? 2.5 : 1;
      ctx.strokeStyle = isSelected ? "#0f172a" : isHover ? "#334155" : "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();

      if (isSelected) {
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(x, y, r + 6, 0, Math.PI * 2);
        ctx.strokeStyle = "#4f46e5";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // 라벨 — 가까운 노드부터, 이미 놓인 라벨과 겹치면 건너뛴다(최대 40개).
    ctx.font = "600 11.5px system-ui, 'Malgun Gothic', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const taken: number[] = []; // x0,y0,x1,y1 평면 배열
    let labelled = 0;
    for (let o = scene.count - 1; o >= 0 && labelled < 40; o -= 1) {
      const i = orderAt(scene, o);
      const forced = selectedRef.current === i || hoverRef.current === i;
      if (projected(scene, i, 3) < 0.3 && !forced) continue;
      const raw = nodesRef.current[i]?.title ?? "";
      if (!raw) continue;
      const title = raw.length > 18 ? `${raw.slice(0, 17)}…` : raw;
      const x = projected(scene, i, 0);
      const y = projected(scene, i, 1) - screenRadius(scene, i) - 7;
      const half = ctx.measureText(title).width / 2 + 3;
      let blocked = false;
      for (let t = 0; t < taken.length && !blocked; t += 4) {
        blocked =
          x + half > (taken[t] as number) &&
          x - half < (taken[t + 2] as number) &&
          y + 4 > (taken[t + 1] as number) &&
          y - 11 < (taken[t + 3] as number);
      }
      if (blocked && !forced) continue;
      taken.push(x - half, y - 11, x + half, y + 4);

      ctx.globalAlpha = forced ? 1 : depthAlpha(scene, i, camera.distance) * 0.9;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.strokeText(title, x, y);
      ctx.fillStyle = "#0f172a";
      ctx.fillText(title, x, y);
      labelled += 1;
    }
    ctx.globalAlpha = 1;
  }, []);

  const tick = useCallback((): void => {
    const scene = sceneRef.current;
    frameRef.current = 0;
    if (!scene) return;

    const steps = reducedMotion.current || scene.count > 400 ? 8 : 1;
    for (let i = 0; i < steps && scene.alpha > ALPHA_MIN; i += 1) stepScene(scene);
    if (!fittedRef.current) {
      cameraRef.current.distance = fitDistance(scene);
      if (scene.alpha <= ALPHA_MIN) fittedRef.current = true;
    }
    if (spinRef.current && !pointerRef.current.down) cameraRef.current.yaw += 0.0035;

    // 모션 감소에서는 배치 중간 프레임을 표시하지 않고 완성된 3D 배치만 보여준다.
    if (!reducedMotion.current || scene.alpha <= ALPHA_MIN) draw();
    const canvas = canvasRef.current;
    if (canvas && scene.alpha <= ALPHA_MIN && canvas.dataset.layout !== "settled") {
      canvas.dataset.layout = "settled";
      setLayoutBusy(false);
    }

    if (scene.alpha > ALPHA_MIN || spinRef.current || pointerRef.current.down) {
      frameRef.current = requestAnimationFrame(tick);
    }
  }, [draw]);

  const kick = useCallback((): void => {
    if (frameRef.current === 0) frameRef.current = requestAnimationFrame(tick);
  }, [tick]);

  const loadGraph = useCallback(async (): Promise<void> => {
    if (!apiSession) return;
    graphRequest.current?.abort();
    const controller = new AbortController();
    graphRequest.current = controller;
    setGraphLoading(true);
    try {
      const graph = graphSchema.parse(await apiRequest(`${vaultBase}/graph`, { session: apiSession, signal: controller.signal }));
      if (controller.signal.aborted) return;
      const scene = buildScene(graph);
      const box = canvasRef.current?.getBoundingClientRect();
      if (box) { scene.width = box.width; scene.height = box.height; }
      nodesRef.current = graph.nodes;
      setNodeOptions(graph.nodes);
      setFolders([...new Set(graph.nodes.map(node => node.folder))].sort());
      paletteRef.current = folderPalette(graph.nodes);
      sceneRef.current = scene;
      selectedRef.current = graph.nodes.findIndex(node => node.id === selectedId.current);
      hoverRef.current = -1;
      fittedRef.current = false;
      if (canvasRef.current) canvasRef.current.dataset.layout = "settling";
      setLayoutBusy(true);
      setStats({
        nodes: graph.nodes.length,
        links: scene.linkCount,
        orphans: Array.from(scene.degree).filter(degree => degree === 0).length,
        unresolved: scene.unresolved,
      });
      setError(null);
      kick();
    } catch (caught) {
      if (!controller.signal.aborted) setError(userMessageOf(caught));
    } finally {
      if (graphRequest.current === controller) {
        graphRequest.current = null;
        setGraphLoading(false);
      }
    }
  }, [apiSession, vaultBase, kick]);

  useEffect(() => {
    selectedId.current = null;
    selectionEpoch.current += 1;
    setSelected(null);
    setDraft(EMPTY_DRAFT);
    setLoadingNote(false);
    setSaving(false);
    setNotice(null);
    sceneRef.current = null;
    nodesRef.current = [];
    selectedRef.current = -1;
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setNodeOptions([]);
    setStats({ nodes: 0, links: 0, orphans: 0, unresolved: 0 });
    void loadGraph();
    return () => {
      openRequest.current?.abort();
      graphRequest.current?.abort();
      mutationRequest.current?.abort();
      openRequest.current = null;
      graphRequest.current = null;
      mutationRequest.current = null;
    };
  }, [loadGraph]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = (): void => {
      reducedMotion.current = media.matches;
      if (media.matches) { spinRef.current = false; setSpin(false); }
      kick();
    };
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, [kick]);

  const openNode = useCallback(
    async (index: number): Promise<void> => {
      const node = nodesRef.current[index];
      if (!apiSession || !node) return;
      openRequest.current?.abort();
      const controller = new AbortController();
      openRequest.current = controller;
      selectionEpoch.current += 1;
      selectedId.current = node.id;
      selectedRef.current = index;
      setSelected(null);
      setDraft(EMPTY_DRAFT);
      setLoadingNote(true);
      setError(null);
      setNotice(null);
      kick();
      try {
        const detail = noteDetailSchema.parse(
          await apiRequest(`${vaultBase}/notes/${node.id}`, { session: apiSession, signal: controller.signal }),
        );
        if (controller.signal.aborted) return;
        setSelected({ id: detail.id, title: detail.title, version: detail.version });
        setDraft(draftOf(detail));
      } catch (caught) {
        if (!controller.signal.aborted) setError(userMessageOf(caught));
      } finally {
        if (openRequest.current === controller) {
          openRequest.current = null;
          setLoadingNote(false);
        }
      }
    },
    [apiSession, vaultBase, kick],
  );

  async function save(): Promise<void> {
    if (!apiSession || !selected || busy || mutationRequest.current || draft.title.trim() === "") return;
    const epoch = selectionEpoch.current;
    const controller = new AbortController();
    mutationRequest.current = controller;
    setSaving(true);
    setError(null);
    try {
      const updated = noteSchema.parse(
        await apiRequest(`${vaultBase}/notes/${selected.id}`, {
          method: "PATCH",
          session: apiSession,
          signal: controller.signal,
          body: {
            title: draft.title.trim(),
            content: draft.content,
            folder: draft.folder.trim() || "/",
            ...(vaultBase === "/vault" ? { tags: tagsOf(draft), pinned: draft.pinned, agent_enabled: draft.agent_enabled } : {}),
            version: selected.version,
          },
        }),
      );
      if (controller.signal.aborted) return;
      if (selectionEpoch.current === epoch) {
        setSelected({ id: updated.id, title: updated.title, version: updated.version });
        setNotice(`${updated.title} 노트를 저장했습니다. 링크를 다시 그립니다.`);
      }
      await loadGraph();
    } catch (caught) {
      if (!controller.signal.aborted) setError(userMessageOf(caught));
    } finally {
      if (mutationRequest.current === controller) {
        mutationRequest.current = null;
        setSaving(false);
      }
    }
  }

  async function remove(): Promise<void> {
    if (!apiSession || !selected || busy || mutationRequest.current) return;
    const epoch = selectionEpoch.current;
    const controller = new AbortController();
    mutationRequest.current = controller;
    setSaving(true);
    setError(null);
    try {
      await apiRequest(`${vaultBase}/notes/${selected.id}`, { method: "DELETE", session: apiSession, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (selectionEpoch.current === epoch) {
        selectedId.current = null;
        selectedRef.current = -1;
        setSelected(null);
        setDraft(EMPTY_DRAFT);
        setNotice("노트를 삭제했습니다.");
      }
      await loadGraph();
    } catch (caught) {
      if (!controller.signal.aborted) setError(userMessageOf(caught));
    } finally {
      if (mutationRequest.current === controller) {
        mutationRequest.current = null;
        setSaving(false);
      }
    }
  }

  // 캔버스 크기 동기화 + 휠 확대(수동 리스너라야 preventDefault 가 먹는다).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = (): void => {
      const ratio = window.devicePixelRatio || 1;
      const box = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(box.width * ratio));
      canvas.height = Math.max(1, Math.round(box.height * ratio));
      const scene = sceneRef.current;
      if (scene) {
        scene.width = box.width;
        scene.height = box.height;
        cameraRef.current.distance = fitDistance(scene);
      }
      kick();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const camera = cameraRef.current;
      const scene = sceneRef.current;
      if (!scene || event.deltaY === 0) return;
      fittedRef.current = true;
      camera.distance = Math.min(fitDistance(scene) * 4, Math.max(160, camera.distance * (event.deltaY > 0 ? 1.12 : 0.89)));
      kick();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [kick]);

  function localPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const box = canvasRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  }

  return (
    <div className="screen" data-screen-id={screen.id}>
      <header className="screen-header">
        <div>
          <div className="screen-header__meta">
            <span className="eyebrow">개인</span>
            <Badge>{screen.id}</Badge>
            <Badge tone="neutral">3D</Badge>
          </div>
          <h1>{screen.label}</h1>
          <p>노드를 끌어 회전하고 휠로 확대합니다. 노드를 누르면 오른쪽에서 바로 읽고 고칠 수 있습니다.</p>
        </div>
        <div className="screen-header__actions">
          <Button
            tone={spin ? "primary" : "neutral"}
            aria-pressed={spin}
            size="small"
            onClick={() => {
              spinRef.current = !spinRef.current;
              setSpin(spinRef.current);
              kick();
            }}
          >
            {spin ? "자동 회전 끄기" : "자동 회전"}
          </Button>
          <Button
            tone="neutral"
            size="small"
            onClick={() => {
              const scene = sceneRef.current;
              if (!scene) return;
              fittedRef.current = true;
              cameraRef.current = { yaw: 0.6, pitch: 0.35, distance: fitDistance(scene) };
              kick();
            }}
          >
            화면 맞춤
          </Button>
          <Button tone="neutral" size="small" onClick={() => void loadGraph()}>
            새로고침
          </Button>
        </div>
      </header>

      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && (
        <div className="screen-notice" role="status">
          <span>{notice}</span>
          <Button tone="ghost" size="small" onClick={() => setNotice(null)}>닫기</Button>
        </div>
      )}

      <div className="graph-layout">
        <SectionCard
          padded={false}
          title="지식 그래프"
          subtitle={`노드 ${stats.nodes} · 연결 ${stats.links} · 고립 ${stats.orphans}${stats.unresolved > 0 ? ` · 끊어진 링크 ${stats.unresolved}` : ""}`}
          foot="드래그/방향키: 회전 · 휠/+/-: 확대 · Home: 맞춤 · 아래 목록: 노트 선택"
        >
          <div className="graph-stage">
            <canvas
              ref={canvasRef}
              className="graph-stage__canvas"
              style={{ visibility: graphLoading || (layoutBusy && reducedMotion.current) ? "hidden" : "visible" }}
              role="application"
              aria-label="개인 노트 3D 그래프"
              aria-busy={graphLoading || layoutBusy}
              tabIndex={0}
              onKeyDown={(event) => {
                const scene = sceneRef.current;
                if (!scene) return;
                const camera = cameraRef.current;
                switch (event.key) {
                  case "ArrowLeft": camera.yaw -= 0.12; break;
                  case "ArrowRight": camera.yaw += 0.12; break;
                  case "ArrowUp": camera.pitch = Math.max(-1.45, camera.pitch - 0.12); break;
                  case "ArrowDown": camera.pitch = Math.min(1.45, camera.pitch + 0.12); break;
                  case "+": case "=": camera.distance = Math.max(160, camera.distance * 0.89); break;
                  case "-": camera.distance = Math.min(fitDistance(scene) * 4, camera.distance * 1.12); break;
                  case "Home": cameraRef.current = { yaw: 0.6, pitch: 0.35, distance: fitDistance(scene) }; break;
                  default: return;
                }
                event.preventDefault();
                fittedRef.current = true;
                kick();
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                const point = localPoint(event);
                pointerRef.current = { down: true, x: point.x, y: point.y, moved: 0 };
              }}
              onPointerMove={(event) => {
                const point = localPoint(event);
                const pointer = pointerRef.current;
                if (!pointer.down) {
                  const scene = sceneRef.current;
                  if (!scene) return;
                  const hit = pickNode(scene, point.x, point.y);
                  if (hit !== hoverRef.current) {
                    hoverRef.current = hit;
                    kick();
                  }
                  return;
                }
                const dx = point.x - pointer.x;
                const dy = point.y - pointer.y;
                pointer.moved += Math.abs(dx) + Math.abs(dy);
                pointer.x = point.x;
                pointer.y = point.y;
                const camera = cameraRef.current;
                fittedRef.current = true;
                camera.yaw += dx * 0.008;
                camera.pitch = Math.max(-1.45, Math.min(1.45, camera.pitch + dy * 0.008));
                kick();
              }}
              onPointerUp={(event) => {
                const pointer = pointerRef.current;
                pointer.down = false;
                if (pointer.moved > 6) {
                  kick();
                  return;
                }
                const scene = sceneRef.current;
                if (!scene) return;
                const point = localPoint(event);
                const hit = pickNode(scene, point.x, point.y);
                if (hit >= 0) void openNode(hit);
              }}
              onPointerCancel={() => {
                pointerRef.current.down = false;
              }}
            />
            {(graphLoading || (layoutBusy && reducedMotion.current)) && (
              <p className="graph-stage__empty" role="status">그래프를 불러오고 배치하는 중…</p>
            )}
            {!graphLoading && !error && stats.nodes === 0 && (
              <p className="graph-stage__empty">
                아직 노트가 없습니다. 개인 노트 화면에서 노트를 만들고 <code>[[다른 노트 제목]]</code> 으로 연결하면
                여기에 3D 로 나타납니다.
              </p>
            )}
          </div>
          <label className="graph-note-picker">
            노트 선택
            <select
              aria-label="그래프 노트 선택"
              value={selectedId.current ?? ""}
              onChange={(event) => {
                const index = nodesRef.current.findIndex(node => node.id === event.target.value);
                if (index >= 0) void openNode(index);
              }}
            >
              <option value="" disabled>노트를 선택하세요</option>
              {nodeOptions.map(node => <option key={node.id} value={node.id}>{node.title} · {node.folder}</option>)}
            </select>
          </label>
        </SectionCard>

        <SectionCard
          padded
          title={selected ? selected.title : "노트 미리보기"}
          subtitle={selected ? "고치고 저장하면 그래프가 다시 그려집니다" : "그래프에서 노드를 눌러 선택하세요"}
        >
          {loadingNote && <p role="status">노트를 불러오는 중…</p>}
          {selected ? (
            <fieldset className="graph-editor" data-note-id={selected.id} disabled={busy}>
            <NoteEditor
              key={selected.id}
              storage={vaultBase === "/pg/vault" ? "pg" : "legacy"}
              draft={draft}
              editingId={selected.id}
              folders={folders}
              busy={busy}
              onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
              onSave={() => void save()}
              onDelete={() => void remove()}
              onReset={() => {
                openRequest.current?.abort();
                selectedId.current = null;
                selectionEpoch.current += 1;
                selectedRef.current = -1;
                setSelected(null);
                setDraft(EMPTY_DRAFT);
                kick();
              }}
            />
            </fieldset>
          ) : (
            <p className="vault-empty">
              노드를 클릭하면 내용이 여기에 열립니다. 편집·미리보기 탭으로 마크다운을 확인하고 바로 저장할 수 있습니다.
            </p>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
