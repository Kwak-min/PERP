import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { Button } from "../../components/ui/Button";
import { useModalFocus } from "../../hooks/useModalFocus";
import { ApiError, apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import "../orglog.css";

const entrySchema = z.object({
  id: z.string(),
  action: z.string(),
  action_label: z.string(),
  target: z.string().nullable(),
  actor_name: z.string(),
  actor_kind: z.string(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
});
const listSchema = z.object({ items: z.array(entrySchema) });
type Entry = z.infer<typeof entrySchema>;
type LogState = Readonly<{ status: "loading" | "ready" | "empty" | "unsupported" | "error"; entries: readonly Entry[]; error: string | null }>;
const FIELD_LABELS: Readonly<Record<string, string>> = {
  department_id: "부서", title: "직책", roles: "역할", name: "이름", parent_id: "상위 부서",
  leader_id: "책임자", access_roles: "접근 그룹", status: "상태",
};
function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "없음";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
function diffOf(entry: Entry) {
  return [...new Set([...Object.keys(entry.before ?? {}), ...Object.keys(entry.after ?? {})])]
    .filter(key => JSON.stringify(entry.before?.[key]) !== JSON.stringify(entry.after?.[key]))
    .map(key => ({ key, field: FIELD_LABELS[key] ?? key, before: display(entry.before?.[key]), after: display(entry.after?.[key]) }))
    .filter(row => row.before !== row.after);
}

export function OrgLogModal({ session, onClose }: Readonly<{ session: ApiSession; onClose: () => void }>) {
  const dialogRef = useModalFocus<HTMLDivElement>(onClose);
  const [state, setState] = useState<LogState>({ status: "loading", entries: [], error: null });
  const [filter, setFilter] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", entries: [], error: null });
    setFilter("");
    apiRequest("/pg/members/activity?limit=200", { session, signal: controller.signal }).then(payload => {
      const entries = listSchema.parse(payload).items;
      if (!controller.signal.aborted) setState({ status: entries.length ? "ready" : "empty", entries, error: null });
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      const unsupported = caught instanceof ApiError && caught.status === 501 && caught.code === "NOT_IMPLEMENTED";
      setState({ status: unsupported ? "unsupported" : "error", entries: [], error: unsupported
        ? "이 조직의 PG 감사 기록 저장소는 아직 연결되지 않았습니다. 변경 이력 유무를 확인할 수 없습니다."
        : userMessageOf(caught) });
    });
    return () => controller.abort();
  }, [session, revision]);
  const filters = useMemo(() => [...new Map(state.entries.map(entry => [entry.action, entry.action_label])).entries()], [state.entries]);
  const visible = state.entries.filter(entry => !filter || entry.action === filter);
  return <div className="modal-scrim" role="presentation" onMouseDown={onClose}>
    <div ref={dialogRef} id="org-log-dialog" className="modal orglog-modal" role="dialog" aria-modal="true" aria-labelledby="org-log-title" tabIndex={-1} onMouseDown={event => event.stopPropagation()} data-org-log-state={state.status}>
      <header className="modal__head">
        <div><span className="eyebrow">감사로그 기반</span><h2 id="org-log-title">조직 변경 로그</h2><p>조직도·구성원·부서 변경 이력 (최근 200건)</p></div>
        <Button tone="neutral" size="small" data-org-log-close onClick={onClose} aria-label="조직 변경 로그 닫기">닫기</Button>
      </header>
      <div className="orglog-modal__toolbar"><Button tone="neutral" size="small" disabled={state.status === "loading"} onClick={() => setRevision(value => value + 1)}>새로 고침</Button></div>
      {state.status === "loading" ? <p className="orglog-empty" role="status">변경 이력을 불러오는 중입니다…</p>
        : state.error ? <div className="form-error" role="alert">{state.error}</div>
        : <>
          <div className="orglog-filters" aria-label="변경 유형">
            <button type="button" className={!filter ? "chip chip--on" : "chip"} aria-pressed={!filter} onClick={() => setFilter("")}>전체</button>
            {filters.map(([action, label]) => <button key={action} type="button" className={filter === action ? "chip chip--on" : "chip"} aria-pressed={filter === action} onClick={() => setFilter(action)}>{label}</button>)}
            <span className="filter-bar__result" role="status">{visible.length}건</span>
          </div>
          {visible.length === 0 ? <p className="orglog-empty">해당 조건의 변경 이력이 없습니다.</p>
            : <ol className="orglog-list">{visible.map(entry => <li key={entry.id}>
              <div className="orglog-item__head"><time className="orglog-item__when" dateTime={entry.created_at}>{entry.created_at.replace("T", " ").slice(0, 19)}</time><b>{entry.action_label}</b>{entry.target && <span className="orglog-item__target">{entry.target}</span>}<span className="orglog-item__actor">{entry.actor_name}{entry.actor_kind !== "user" ? ` (${entry.actor_kind})` : ""}</span></div>
              <ul className="orglog-item__diff">{diffOf(entry).map(row => <li key={row.key}><span>{row.field}</span><del>{row.before}</del><span aria-hidden="true">→</span><ins>{row.after}</ins></li>)}</ul>
            </li>)}</ol>}
        </>}
    </div>
  </div>;
}
