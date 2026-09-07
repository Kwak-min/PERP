import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, userMessageOf } from "../services/api";
import { useSession } from "../store/session";
import { MarkdownView } from "./vault/MarkdownView";
import {
  ALPHA_MIN,
  buildScene,
  depthAlpha,
  fitDistance,
  folderPalette,
  lighten,
  linkEnds,
  orderAt,
  pickNode,
  projectScene,
  projected,
  screenRadius,
  stepScene,
  type Camera,
  type Scene,
} from "./vault/graph3d";
import {
  SENSITIVITY_LABEL,
  documentDetailSchema,
  knowledgeGraphSchema,
  type KnowledgeNode,
} from "./knowledge/model";

import "./graph-stage.css";

type Pointer = { down: boolean; x: number; y: number; moved: number };

export function KnowledgeGraphScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const cameraRef = useRef<Camera>({ yaw: 0.6, pitch: 0.35, distance: 900 });
  const nodesRef = useRef<readonly KnowledgeNode[]>([]);
  const paletteRef = useRef<ReadonlyMap<string, string>>(new Map());
  const selectedRef = useRef<number>(-1);
  const hoverRef = useRef<number>(-1);
  const spinRef = useRef<boolean>(true);
  const frameRef = useRef<number>(0);
  const fittedRef = useRef<boolean>(false);
  const pointerRef = useRef<Pointer>({ down: false, x: 0, y: 0, moved: 0 });
  const openRequest = useRef<AbortController | null>(null);

  const [stats, setStats] = useState({ documents: 0, spaces: 0, chunks: 0, restricted: 0 });
  const [selected, setSelected] = useState<KnowledgeNode | null>(null);
  const [detail, setDetail] = useState<{ content: string; version: number; revisions: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [spin, setSpin] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apiSession = useMemo(
    () => (session?.orgId ? { token: session.token, orgId: session.orgId } : null),
    [session?.token, session?.orgId],
  );

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

    for (let l = 0; l < scene.linkCount; l += 1) {
      const [a, b] = linkEnds(scene, l);
      const near = selectedRef.current === a || selectedRef.current === b;
      const fog = (depthAlpha(scene, a, camera.distance) + depthAlpha(scene, b, camera.distance)) / 2;
      ctx.strokeStyle = near
        ? `rgba(79,70,229,${(0.55 + fog * 0.4).toFixed(3)})`
        : `rgba(100,116,139,${(fog * 0.3).toFixed(3)})`;
      ctx.lineWidth = near ? 1.8 : 1;
      ctx.beginPath();
      ctx.moveTo(projected(scene, a, 0), projected(scene, a, 1));
      ctx.lineTo(projected(scene, b, 0), projected(scene, b, 1));
      ctx.stroke();
    }

    const palette = paletteRef.current;
    for (let o = 0; o < scene.count; o += 1) {
      const i = orderAt(scene, o);
      const node = nodesRef.current[i];
      const x = projected(scene, i, 0);
      const y = projected(scene, i, 1);
      const r = screenRadius(scene, i);
      const fog = depthAlpha(scene, i, camera.distance);
      const isSpace = node?.kind === "space";
      const base = palette.get(node?.folder ?? "미분류") ?? "#4f46e5";

      ctx.globalAlpha = fog * 0.22;
      ctx.beginPath();
      ctx.ellipse(x, y + r * 0.95, r * 0.9, r * 0.32, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#0f172a";
      ctx.fill();

      ctx.globalAlpha = fog;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = isSpace ? "#0f172a" : base;
      ctx.fill();

      ctx.globalAlpha = fog * 0.55;
      ctx.beginPath();
      ctx.arc(x - r * 0.3, y - r * 0.34, r * 0.48, 0, Math.PI * 2);
      ctx.fillStyle = lighten(isSpace ? "#334155" : base, 0.7);
      ctx.fill();

      ctx.globalAlpha = Math.min(1, fog + 0.2);
      ctx.lineWidth = selectedRef.current === i ? 2.5 : 1;
      ctx.strokeStyle =
        selectedRef.current === i ? "#0f172a" : hoverRef.current === i ? "#334155" : "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();

      // 민감 문서는 테두리를 한 겹 더 둘러 눈에 띄게 한다.
      if (node?.sensitivity === "sensitive" || node?.sensitivity === "confidential") {
        ctx.globalAlpha = Math.min(1, fog + 0.1);
        ctx.beginPath();
        ctx.arc(x, y, r + 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = "#b91c1c";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (selectedRef.current === i) {
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(x, y, r + 7, 0, Math.PI * 2);
        ctx.strokeStyle = "#4f46e5";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    ctx.font = "600 11.5px system-ui, 'Malgun Gothic', sans-serif";
    ctx.textAlign = "center";
    const taken: number[] = [];
    let labelled = 0;
    for (let o = scene.count - 1; o >= 0 && labelled < 40; o -= 1) {
      const i = orderAt(scene, o);
      const node = nodesRef.current[i];
      const forced = selectedRef.current === i || hoverRef.current === i;
      // 공간 이름은 멀어도 보여주되, 다른 라벨을 덮지는 않는다.
      const alwaysShow = forced || node?.kind === "space";
      if (projected(scene, i, 3) < 0.3 && !alwaysShow) continue;
      const raw = node?.title ?? "";
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
      ctx.fillStyle = node?.kind === "space" ? "#0f172a" : "#1f2937";
      ctx.fillText(title, x, y);
      labelled += 1;
    }
    ctx.globalAlpha = 1;
  }, []);

  const tick = useCallback((): void => {
    const scene = sceneRef.current;
    frameRef.current = 0;
    if (!scene) return;
    if (scene.alpha > ALPHA_MIN) {
      stepScene(scene);
      if (!fittedRef.current && scene.alpha < 0.35) {
        cameraRef.current.distance = fitDistance(scene);
        fittedRef.current = true;
      }
    }
    if (spinRef.current) cameraRef.current.yaw += 0.0035;
    draw();
    if (scene.alpha > ALPHA_MIN || spinRef.current || pointerRef.current.down) {
      frameRef.current = requestAnimationFrame(tick);
    }
  }, [draw]);

  const kick = useCallback((): void => {
    if (frameRef.current === 0) frameRef.current = requestAnimationFrame(tick);
  }, [tick]);

  const loadGraph = useCallback(async (): Promise<void> => {
    if (!apiSession) return;
    try {
      const graph = knowledgeGraphSchema.parse(
        await apiRequest("/documents/graph", { session: apiSession }),
      );
      nodesRef.current = graph.nodes;
      paletteRef.current = folderPalette(graph.nodes);
      sceneRef.current = buildScene({
        nodes: graph.nodes.map((n) => ({ id: n.id, title: n.title, folder: n.folder })),
        edges: graph.edges,
        orphans: graph.orphans,
      });
      selectedRef.current = -1;
      fittedRef.current = false;
      setStats(graph.stats);
      setError(null);
      kick();
    } catch (caught) {
      setError(userMessageOf(caught));
    }
  }, [apiSession, kick]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  const openNode = useCallback(
    async (index: number): Promise<void> => {
      const node = nodesRef.current[index];
      if (!node) return;
      setSelected(node);
      setEditing(false);
      setDetail(null);
      if (!apiSession || node.kind !== "document") return;
      openRequest.current?.abort();
      const controller = new AbortController();
      openRequest.current = controller;
      setBusy(true);
      try {
        const parsed = documentDetailSchema.parse(
          await apiRequest(`/documents/${node.id}`, { session: apiSession, signal: controller.signal }),
        );
        if (controller.signal.aborted) return;
        setDetail({
          content: parsed.content,
          version: parsed.version,
          revisions: parsed.versions.length,
        });
      } catch (caught) {
        if (!controller.signal.aborted) setError(userMessageOf(caught));
      } finally {
        if (openRequest.current === controller) {
          openRequest.current = null;
          setBusy(false);
        }
      }
    },
    [apiSession],
  );

  async function save(): Promise<void> {
    if (!apiSession || !selected || !detail) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/documents/${selected.id}`, {
        method: "PATCH",
        session: apiSession,
        body: { content: detail.content, version: detail.version },
      });
      setNotice(`${selected.title} 문서를 저장했습니다. 새 판으로 기록되고 RAG 색인도 갱신됩니다.`);
      setEditing(false);
      await loadGraph();
      const index = nodesRef.current.findIndex((n) => n.id === selected.id);
      if (index >= 0) await openNode(index);
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = (): void => {
      const ratio = window.devicePixelRatio || 1;
      const box = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(box.width * ratio));
      canvas.height = Math.max(1, Math.round(box.height * ratio));
      kick();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const camera = cameraRef.current;
      camera.distance = Math.min(6000, Math.max(160, camera.distance * (event.deltaY > 0 ? 1.12 : 0.89)));
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

  const membersOfSpace =
    selected?.kind === "space"
      ? nodesRef.current.filter((n) => n.kind === "document" && n.folder === selected.folder)
      : [];

  return (
    <div className="screen" data-screen-id={screen.id}>
      <header className="screen-header">
        <div>
          <div className="screen-header__meta">
            <span className="eyebrow">지식</span>
            <Badge>{screen.id}</Badge>
            <Badge tone="neutral">3D</Badge>
          </div>
          <h1>{screen.label}</h1>
          <p>
            AI Agent 가 근거로 쓰는 조직 문서를 공간별로 묶어 3D 로 봅니다. 노드를 누르면 본문과 색인 상태를
            확인하고 바로 고칠 수 있습니다.
          </p>
        </div>
        <div className="screen-header__actions">
          <Button
            tone={spin ? "primary" : "neutral"}
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
          title="조직 지식 그래프"
          subtitle={`문서 ${stats.documents} · 공간 ${stats.spaces} · RAG 청크 ${stats.chunks}${
            stats.restricted > 0 ? ` · 권한 밖 ${stats.restricted}` : ""
          }`}
          foot="검은 노드=공간 · 붉은 테두리=민감 문서 · 드래그: 회전 · 휠: 확대"
        >
          <div className="graph-stage">
            <canvas
              ref={canvasRef}
              className="graph-stage__canvas"
              role="application"
              aria-label="조직 지식 3D 그래프"
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
                selectedRef.current = hit;
                kick();
                if (hit >= 0) void openNode(hit);
              }}
              onPointerCancel={() => {
                pointerRef.current.down = false;
              }}
            />
            {stats.documents === 0 && (
              <p className="graph-stage__empty">
                아직 조직 문서가 없습니다. 문서 화면에서 문서를 만들고 본문에{" "}
                <code>[[다른 문서 제목]]</code> 을 적으면 여기에서 연결로 보입니다.
              </p>
            )}
          </div>
        </SectionCard>

        <SectionCard
          padded
          title={selected ? selected.title : "노드 상세"}
          subtitle={
            selected
              ? selected.kind === "space"
                ? "공간에 속한 문서"
                : "AI Agent 가 인용할 수 있는 문서"
              : "그래프에서 노드를 눌러 선택하세요"
          }
        >
          {!selected && (
            <p className="vault-empty">
              공간(검은 노드)을 누르면 그 공간의 문서 목록이, 문서를 누르면 본문과 색인 상태가 열립니다.
            </p>
          )}

          {selected?.kind === "space" && (
            <ul className="vault-list">
              {membersOfSpace.map((doc) => (
                <li key={doc.id}>
                  <button
                    type="button"
                    className="vault-list__item"
                    onClick={() => {
                      const index = nodesRef.current.findIndex((n) => n.id === doc.id);
                      if (index < 0) return;
                      selectedRef.current = index;
                      kick();
                      void openNode(index);
                    }}
                  >
                    <b>{doc.title}</b>
                    <span>
                      {SENSITIVITY_LABEL[doc.sensitivity] ?? doc.sensitivity} · 청크 {doc.chunks}
                    </span>
                  </button>
                </li>
              ))}
              {membersOfSpace.length === 0 && <li className="vault-empty">문서가 없는 공간입니다.</li>}
            </ul>
          )}

          {selected?.kind === "document" && (
            <>
              <ul className="graph-meta">
                <li><b>공간</b><span>{selected.folder}</span></li>
                <li><b>민감도</b><span>{SENSITIVITY_LABEL[selected.sensitivity] ?? selected.sensitivity}</span></li>
                <li><b>RAG 청크</b><span>{selected.chunks}개</span></li>
                {selected.tags.length > 0 && <li><b>태그</b><span>{selected.tags.join(", ")}</span></li>}
                {detail && <li><b>판</b><span>v{detail.version} · 이력 {detail.revisions}건</span></li>}
              </ul>

              {busy && !detail && <p className="vault-empty">문서를 불러오는 중…</p>}

              {detail && !editing && (
                <>
                  <div className="note-editor__preview">
                    <MarkdownView source={detail.content} />
                  </div>
                  <div className="form-actions">
                    <Button size="small" onClick={() => setEditing(true)}>본문 수정</Button>
                    <Link className="text-button" to={`/documents/${selected.id}`}>문서 화면에서 열기</Link>
                  </div>
                </>
              )}

              {detail && editing && (
                <div className="note-editor">
                  <label>
                    본문 (마크다운)
                    <textarea
                      className="note-editor__markdown"
                      rows={14}
                      value={detail.content}
                      onChange={(event) => setDetail({ ...detail, content: event.target.value })}
                    />
                  </label>
                  <div className="form-actions">
                    <Button size="small" disabled={busy} onClick={() => void save()}>
                      {busy ? "저장 중…" : "변경 저장"}
                    </Button>
                    <Button tone="neutral" size="small" onClick={() => setEditing(false)}>취소</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
