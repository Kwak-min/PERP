import { useEffect, useRef } from "react";

import { Icon } from "../components/ui/Icon";
import { demoNotes, noteLinks } from "./mockup/demo";
import { PageHead, clamp } from "./mockup/lib";

type GNode = {
  id: string;
  label: string;
  isAi?: boolean | undefined;
  ghost?: boolean | undefined;
  noteId?: number | undefined;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  screenX?: number;
  screenY?: number;
  screenR?: number;
  projScale?: number;
  projZ?: number;
};

// VLT-002 Vault 3D 지식 그래프 — 목업 drawGraph3D 이식
export function VaultGraphScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef({ autoRot: true, rotX: 0.3, rotY: 0.5, zoom: 1.0 });

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const notes = demoNotes;
    const byTitle = new Map(notes.map((n) => [n.title, n]));
    const nodes: GNode[] = notes.map((n) => ({
      id: "n" + n.id,
      label: n.title,
      isAi: n.agent,
      noteId: n.id,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
    }));
    const ghosts = new Map<string, GNode>();
    const edges: [string, string][] = [];
    notes.forEach((n) =>
      noteLinks(n).forEach((t) => {
        const tgt = byTitle.get(t);
        let tid: string;
        if (tgt) tid = "n" + tgt.id;
        else {
          if (!ghosts.has(t))
            ghosts.set(t, { id: "g" + t, label: t, ghost: true, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
          tid = "g" + t;
        }
        edges.push(["n" + n.id, tid]);
      }),
    );
    nodes.push(...ghosts.values());

    const parent = cv.parentElement!;
    const W = parent.clientWidth || 800,
      H = 520,
      dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = W + "px";
    cv.style.height = H + "px";
    const ctx = cv.getContext("2d")!;
    ctx.scale(dpr, dpr);

    const numNodes = nodes.length;
    nodes.forEach((n, i) => {
      const phi = Math.acos(-1 + (2 * i) / numNodes);
      const theta = Math.sqrt(numNodes * Math.PI) * phi;
      const r = 160 + Math.random() * 40;
      n.x = r * Math.cos(theta) * Math.sin(phi);
      n.y = r * Math.sin(theta) * Math.sin(phi);
      n.z = r * Math.cos(phi);
    });

    const idxMap: Record<string, GNode> = Object.fromEntries(nodes.map((n) => [n.id, n]));
    for (let iter = 0; iter < 180; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]!,
            b = nodes[j]!;
          const dx = a.x - b.x,
            dy = a.y - b.y,
            dz = a.z - b.z;
          const d2 = dx * dx + dy * dy + dz * dz + 0.1,
            d = Math.sqrt(d2);
          const f = 22000 / d2;
          a.vx += (dx / d) * f;
          a.vy += (dy / d) * f;
          a.vz += (dz / d) * f;
          b.vx -= (dx / d) * f;
          b.vy -= (dy / d) * f;
          b.vz -= (dz / d) * f;
        }
      }
      edges.forEach(([s, t]) => {
        const a = idxMap[s],
          b = idxMap[t];
        if (!a || !b) return;
        const dx = b.x - a.x,
          dy = b.y - a.y,
          dz = b.z - a.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.1;
        const f = (d - 120) * 0.04;
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        a.vz += (dz / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
        b.vz -= (dz / d) * f;
      });
      nodes.forEach((n) => {
        n.vx -= n.x * 0.005;
        n.vy -= n.y * 0.005;
        n.vz -= n.z * 0.005;
        n.x += clamp(n.vx, -8, 8);
        n.y += clamp(n.vy, -8, 8);
        n.z += clamp(n.vz, -8, 8);
        n.vx *= 0.85;
        n.vy *= 0.85;
        n.vz *= 0.85;
      });
    }

    const stars = Array.from({ length: 60 }, () => ({
      x: (Math.random() - 0.5) * 600,
      y: (Math.random() - 0.5) * 600,
      z: (Math.random() - 0.5) * 600,
      r: Math.random() * 1.5 + 0.5,
    }));

    let hoverNode: GNode | null = null;
    let isDragging = false,
      lastMX = 0,
      lastMY = 0;
    let animId = 0;

    const onDown = (e: MouseEvent) => {
      isDragging = true;
      lastMX = e.clientX;
      lastMY = e.clientY;
    };
    const onMove = (e: MouseEvent) => {
      if (isDragging) {
        view.current.rotY += (e.clientX - lastMX) * 0.005;
        view.current.rotX += (e.clientY - lastMY) * 0.005;
        lastMX = e.clientX;
        lastMY = e.clientY;
      }
      const rect = cv.getBoundingClientRect();
      const mx = e.clientX - rect.left,
        my = e.clientY - rect.top;
      if (mx >= 0 && mx <= W && my >= 0 && my <= H) {
        hoverNode =
          nodes.find(
            (n) =>
              n.screenX != null &&
              Math.hypot(n.screenX - mx, (n.screenY ?? 0) - my) < (n.screenR ?? 10) + 4,
          ) || null;
        cv.style.cursor = hoverNode ? "pointer" : isDragging ? "grabbing" : "grab";
      }
    };
    const onUp = () => {
      isDragging = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      view.current.zoom = clamp(view.current.zoom - e.deltaY * 0.0015, 0.4, 2.5);
    };
    const onClick = () => {
      if (hoverNode && !hoverNode.ghost && hoverNode.noteId != null) {
        location.hash = `#/vault/${hoverNode.noteId}`;
      }
    };
    cv.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    cv.addEventListener("wheel", onWheel, { passive: false });
    cv.addEventListener("click", onClick);

    const cs = getComputedStyle(document.documentElement);
    const tok = (k: string) => cs.getPropertyValue(k).trim();
    const primaryCol = tok("--of-primary") || "#4F46E5";
    const aiCol = tok("--of-ai") || "#7C3AED";
    const textCol = tok("--of-text") || "#0F172A";
    const fontFam = tok("--of-font") || "sans-serif";

    function renderFrame() {
      const v = view.current;
      if (v.autoRot && !isDragging) v.rotY += 0.003;
      ctx.clearRect(0, 0, W, H);

      const cosX = Math.cos(v.rotX),
        sinX = Math.sin(v.rotX);
      const cosY = Math.cos(v.rotY),
        sinY = Math.sin(v.rotY);
      const focal = 400 * v.zoom;

      const project = (x: number, y: number, z: number) => {
        const y1 = y * cosX - z * sinX;
        const z1 = y * sinX + z * cosX;
        const x2 = x * cosY + z1 * sinY;
        const z2 = -x * sinY + z1 * cosY;
        const scale = focal / (focal + z2 + 350);
        return { px: W / 2 + x2 * scale, py: H / 2 + y1 * scale, scale, z: z2 };
      };

      stars.forEach((s) => {
        const p = project(s.x, s.y, s.z);
        if (p.scale > 0) {
          ctx.beginPath();
          ctx.arc(p.px, p.py, s.r * p.scale, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(99, 102, 241, ${clamp(0.15 * p.scale, 0.05, 0.4)})`;
          ctx.fill();
        }
      });

      nodes.forEach((n) => {
        const p = project(n.x, n.y, n.z);
        n.screenX = p.px;
        n.screenY = p.py;
        n.screenR = (n.ghost ? 7 : 11) * p.scale;
        n.projScale = p.scale;
        n.projZ = p.z;
      });

      edges.forEach(([s, t]) => {
        const a = idxMap[s],
          b = idxMap[t];
        if (!a || !b) return;
        const isHilite = hoverNode && (hoverNode.id === a.id || hoverNode.id === b.id);
        const alpha = isHilite
          ? 0.8
          : clamp(0.25 * (((a.projScale ?? 0) + (b.projScale ?? 0)) / 2), 0.08, 0.4);
        ctx.beginPath();
        ctx.moveTo(a.screenX!, a.screenY!);
        ctx.lineTo(b.screenX!, b.screenY!);
        ctx.lineWidth = (isHilite ? 2.5 : 1.2) * (((a.projScale ?? 0) + (b.projScale ?? 0)) / 2);
        ctx.strokeStyle = isHilite ? "#818CF8" : `rgba(148, 163, 184, ${alpha})`;
        ctx.stroke();
      });

      const sortedNodes = [...nodes].sort((a, b) => (b.projZ ?? 0) - (a.projZ ?? 0));
      sortedNodes.forEach((n) => {
        const r = Math.max(3, n.screenR ?? 3);
        const alpha = clamp(0.4 + (n.projScale ?? 0) * 0.6, 0.3, 1.0);
        const isH = hoverNode === n;
        ctx.save();
        ctx.globalAlpha = alpha;
        const grad = ctx.createRadialGradient(
          n.screenX! - r * 0.3,
          n.screenY! - r * 0.3,
          r * 0.1,
          n.screenX!,
          n.screenY!,
          r,
        );
        if (n.ghost) {
          grad.addColorStop(0, "#CBD5E1");
          grad.addColorStop(1, "#64748B");
        } else if (n.isAi) {
          grad.addColorStop(0, "#C4B5FD");
          grad.addColorStop(1, aiCol);
        } else {
          grad.addColorStop(0, "#818CF8");
          grad.addColorStop(1, primaryCol);
        }
        if (isH) {
          ctx.beginPath();
          ctx.arc(n.screenX!, n.screenY!, r + 6, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(99, 102, 241, 0.25)";
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(n.screenX!, n.screenY!, r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.lineWidth = 1.5 * (n.projScale ?? 0);
        ctx.strokeStyle = isH ? "#6366F1" : "rgba(255,255,255,0.7)";
        ctx.stroke();

        const fontSize = Math.max(10, Math.round(12 * (n.projScale ?? 0)));
        ctx.font = `${isH ? "bold " : ""}${fontSize}px ${fontFam}`;
        ctx.textAlign = "center";
        ctx.fillStyle = n.ghost ? "#64748B" : textCol;
        if (isH) {
          const textW = ctx.measureText(n.label).width;
          ctx.fillStyle = primaryCol;
          ctx.fillRect(n.screenX! - textW / 2 - 4, n.screenY! + r + 4, textW + 8, fontSize + 6);
          ctx.fillStyle = "#FFFFFF";
          ctx.fillText(n.label, n.screenX!, n.screenY! + r + 4 + fontSize);
        } else {
          ctx.fillText(n.label, n.screenX!, n.screenY! + r + 14);
        }
        ctx.restore();
      });

      animId = requestAnimationFrame(renderFrame);
    }
    renderFrame();

    return () => {
      cancelAnimationFrame(animId);
      cv.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      cv.removeEventListener("wheel", onWheel);
      cv.removeEventListener("click", onClick);
    };
  }, []);

  return (
    <>
      <PageHead
        title="Vault 3D 지식 그래프 (3D Knowledge Graph)"
        id="VLT-002"
        fr="SFR-017"
        desc="내 노트 사이의 [[위키링크]] 3차원 지식 연관도 그래프입니다. 마우스 드래그로 3D 공간을 회전하고 휠로 확대/축소하세요. 노드를 누르면 노트로 이동합니다."
        actions={
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => (view.current.autoRot = !view.current.autoRot)}
            >
              <Icon name="undo" />
              3D 자동 회전
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                view.current.rotX = 0.3;
                view.current.rotY = 0.5;
                view.current.zoom = 1.0;
              }}
            >
              <Icon name="undo" />
              3D 시점 리셋
            </button>
            <a className="btn" href="#/vault">
              노트 목록
            </a>
          </>
        }
      />
      <div className="panel" style={{ position: "relative" }}>
        <div
          className="graph-wrap"
          style={{
            height: 520,
            background:
              "radial-gradient(circle at center, var(--surface-2) 0%, var(--panel) 100%)",
          }}
        >
          <canvas ref={canvasRef} role="img" aria-label={`노트 ${demoNotes.length}개의 3D 지식 그래프`} />
        </div>
      </div>
      <div className="legend" style={{ marginTop: 10 }}>
        <span>
          <i style={{ background: "var(--of-primary)", borderRadius: "50%" }} />
          일반 노트 (3D 구체)
        </span>
        <span>
          <i style={{ background: "var(--of-ai)", borderRadius: "50%" }} />
          Agent 연동 노트
        </span>
        <span>
          <i style={{ boxShadow: "inset 0 0 0 1.5px var(--border-strong)", borderRadius: "50%" }} />
          미생성 링크 노트
        </span>
        <span>💡 드래그: 3D 공간 회전 · 휠: 3D 줌</span>
      </div>
      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h">
          <h2>3D 연관 지식 네트워크 목록</h2>
        </div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>노트</th>
                <th>나가는 3D 링크</th>
                <th>백링크 수</th>
              </tr>
            </thead>
            <tbody>
              {demoNotes.map((n) => (
                <tr key={n.id}>
                  <td>
                    <a href={`#/vault/${n.id}`}>{n.title}</a>
                  </td>
                  <td>{noteLinks(n).join(", ") || "-"}</td>
                  <td>{demoNotes.filter((x) => noteLinks(x).includes(n.title)).length}개</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
