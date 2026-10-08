// 목업(index.html)의 공통 UI 헬퍼/프리미티브를 React로 이식.
// 마크업과 클래스는 목업을 절대 기준으로 유지한다.
import type { ReactNode } from "react";

import { Icon } from "../../components/ui/Icon";

/* ---------- 포맷 헬퍼 (목업 동일) ---------- */
export const won = (n: number): string => `${Math.round(n || 0).toLocaleString("ko-KR")}원`;
export const num = (n: number): string => Math.round(n || 0).toLocaleString("ko-KR");
export const pct = (a: number, b: number): number => (b ? Math.round((a / b) * 100) : 0);
export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const fmtYM = (ym: string): string => `${ym.slice(0, 4)}년 ${+ym.slice(5)}월`;
export const manwon = (v: number): string =>
  v === 0 ? "0" : v % 10000 === 0 ? `${num(v / 10000)}만` : num(v);

export function niceMax(v: number): { max: number; step: number } {
  if (!(v > 0)) return { max: 100000, step: 25000 };
  const p = Math.pow(10, Math.floor(Math.log10(v / 4)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => v / s <= 4) || 10 * p;
  return { max: Math.ceil(v / step) * step, step };
}

export const colPath = (x: number, y: number, w: number, h: number): string => {
  const r = Math.min(4, h);
  return h <= 0
    ? ""
    : `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};

/* ---------- 프리미티브 ---------- */
export type Trace = { id?: string; fr?: string };

export function PageHead({
  title,
  id,
  fr,
  desc,
  actions,
}: {
  title: ReactNode;
  id?: string;
  fr?: string;
  desc?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="ph">
      <div className="ph-trace">
        {id && <span className="trace-id">{id}</span>}
        {fr && <span className="trace-fr">{fr}</span>}
      </div>
      <div className="ph-row">
        <div className="ph-text">
          <h1>{title}</h1>
          {desc && <p className="ph-desc">{desc}</p>}
        </div>
        {actions && <div className="ph-actions">{actions}</div>}
      </div>
    </header>
  );
}

export function StatTile({
  label,
  value,
  sub,
  tone = "",
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string | undefined;
}) {
  return (
    <div className={`stat ${tone ?? ""}`.trim()}>
      <span className="stat-l">{label}</span>
      <span className="stat-v">{value}</span>
      {sub && <span className="stat-s">{sub}</span>}
    </div>
  );
}

export function Pill({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: string | undefined;
}) {
  return <span className={`pill ${tone ?? "muted"}`.trim()}>{children}</span>;
}

export function Meter({ p, tone = "" }: { p: number; tone?: string | undefined }) {
  return (
    <span className={`meter ${tone}`.trim()} role="img" aria-label={`${p}%`}>
      <span style={{ width: `${clamp(p, 0, 100)}%` }} />
    </span>
  );
}

export function Panel({
  icon,
  title,
  meta,
  children,
  bodyClass = "panel-b",
  style,
}: {
  icon?: string;
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  bodyClass?: string;
  style?: React.CSSProperties;
}) {
  return (
    <section className="panel" style={style}>
      <div className="panel-h">
        <h2>
          {icon && <Icon name={icon} />}
          {title}
        </h2>
        {meta}
      </div>
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Empty({
  title,
  desc,
  icon = "folder",
  action,
}: {
  title: string;
  desc?: string | undefined;
  icon?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <strong>{title}</strong>
      {desc != null && <p>{desc}</p>}
      {action}
    </div>
  );
}

/* ---------- 월별 수입·지출 차트 (monthlyChart 이식) ---------- */
export type MonthPoint = { ym: string; inc: number; exp: number };

export function MonthlyChart({ data }: { data: MonthPoint[] }) {
  const W = 640,
    H = 230,
    L = 52,
    R = 8,
    T = 10,
    B = 26;
  const { max, step } = niceMax(Math.max(...data.map((d) => Math.max(d.inc, d.exp))));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const band = (W - L - R) / data.length,
    bw = Math.min(24, (band - 18) / 2);

  const grid: ReactNode[] = [];
  for (let v = 0, i = 0; v <= max + 1; v += step, i++) {
    grid.push(
      <line
        key={`g${i}`}
        className={v === 0 ? "axis-l" : "grid-l"}
        x1={L}
        x2={W - R}
        y1={y(v)}
        y2={y(v)}
      />,
      <text key={`t${i}`} x={L - 8} y={y(v) + 4} textAnchor="end">
        {manwon(v)}
      </text>,
    );
  }

  const bars = data.map((d, i) => {
    const cx = L + band * i + band / 2;
    const x1 = cx - bw - 1,
      x2 = cx + 1;
    return (
      <g key={d.ym}>
        <path d={colPath(x1, y(d.inc), bw, y(0) - y(d.inc))} style={{ fill: "var(--chart-1)" }} />
        <path d={colPath(x2, y(d.exp), bw, y(0) - y(d.exp))} style={{ fill: "var(--chart-2)" }} />
        <text x={cx} y={H - 8} textAnchor="middle">
          {+d.ym.slice(5)}월
        </text>
      </g>
    );
  });

  return (
    <>
      <div className="row between" style={{ marginBottom: 6 }}>
        <div className="key">
          <span>
            <i style={{ background: "var(--chart-1)" }} />
            수입
          </span>
          <span>
            <i style={{ background: "var(--chart-2)" }} />
            지출
          </span>
        </div>
      </div>
      <div className="chart">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`최근 ${data.length}개월 월별 수입·지출`}>
          {grid}
          {bars}
        </svg>
      </div>
      <p className="hint">단위: 원 (만=10,000) · 확정 전표만 집계 · 초안은 제외</p>
    </>
  );
}

/* ---------- 날짜/상태 헬퍼 (업무 등 공용) ---------- */
const WD = ["일", "월", "화", "수", "목", "금", "토"];
const pad = (n: number) => String(n).padStart(2, "0");
export const fmtDate = (s: string): string => {
  if (!s) return "-";
  const d = new Date(s);
  return `${d.getMonth() + 1}.${pad(d.getDate())} (${WD[d.getDay()]})`;
};
export const daysBetween = (a: string, b: string): number =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
export const todayStr = "2026-09-14";

export const TASK_STATUS: Record<string, string> = {
  todo: "할 일",
  doing: "진행 중",
  review: "검토",
  done: "완료",
};
export const TASK_TONE: Record<string, string> = {
  todo: "muted",
  doing: "info",
  review: "warn",
  done: "ok",
};

export function DueLabel({ due, done = false }: { due: string; done?: boolean }) {
  if (done) return <Pill tone="ok">완료</Pill>;
  const n = daysBetween(todayStr, due);
  const tone = n < 0 ? "bad" : n <= 1 ? "warn" : "muted";
  const text = n < 0 ? `${-n}일 지남` : n === 0 ? "오늘 마감" : `D-${n}`;
  return <Pill tone={tone}>{text}</Pill>;
}

// 아바타 (목업 avatar 이식) — 이름 끝 2글자
export function Av({ name, size = "" }: { name: string; size?: string }) {
  return (
    <span className={`av ${size}`.trim()} title={name}>
      {name.slice(-2)}
    </span>
  );
}

// 수평 막대 (expenseByAccount 이식)
export function HBars({ rows }: { rows: { name: string; v: number }[] }) {
  if (!rows.length) return <Empty title="확정된 지출이 없습니다" icon="folder" />;
  const mx = Math.max(1, ...rows.map((r) => r.v));
  return (
    <>
      {rows.map((r) => (
        <div className="hbar" key={r.name}>
          <span>{r.name}</span>
          <span className="trk">
            <span style={{ width: `${(r.v / mx) * 100}%` }} />
          </span>
          <span className="num">{won(r.v)}</span>
        </div>
      ))}
    </>
  );
}

// 탭 (목업 tabs() 이식) — 제어형
export function Tabs({
  items,
  cur,
  onChange,
}: {
  items: Array<[string, string, number?]>;
  cur: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map(([v, label, n]) => (
        <button
          type="button"
          role="tab"
          key={v}
          aria-selected={v === cur}
          className={`tab${v === cur ? " on" : ""}`}
          onClick={() => onChange(v)}
        >
          {label}
          {n != null && <span className="tab-n">{n}</span>}
        </button>
      ))}
    </div>
  );
}

export const maskPhone = (p: string): string =>
  p ? p.replace(/(\d{3})-?(\d{2})\d{2}-?(\d{2})(\d{2})/, "$1-$2**-**$4") : "-";

// 데이터 등급 칩 (gradeChip 이식)
const GRADE_TONE: Record<string, string> = { 공개: "muted", 내부: "info", 개인: "warn", 민감: "bad", 고기밀: "bad" };
export function GradeChip({ grade }: { grade: string }) {
  return (
    <span
      className={`pill grade ${GRADE_TONE[grade] ?? "muted"}${grade === "고기밀" ? " strong" : ""}`}
      title="데이터 등급"
    >
      {(grade === "고기밀" || grade === "민감") && <Icon name="lock" />}
      {grade}
    </span>
  );
}
