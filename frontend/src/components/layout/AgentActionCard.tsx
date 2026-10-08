import { useEffect, useRef, useState } from "react";
import {
  cancelAgentOperation, confirmAgentOperation, executeAgentOperation, getAgentApprovers, getAgentOperation,
  type AgentApprover, type AgentOperation, type AgentOperationRequest, type AgentKnowledgeMode,
} from "../../services/agent";
import { ApiError, userMessageOf, type ApiSession } from "../../services/api";
import { Button } from "../ui/Button";
import { createRequestKey } from "../../services/requestKey";
import "./agent-actions.css";

const STATUS = { preview: "미리보기", confirmed: "확인됨", executed: "실행 완료", cancelled: "취소됨", failed: "실행 실패" } as const;

export function AgentActionCard({ initial, session, active, knowledgeMode }: Readonly<{ initial: AgentOperation; session: ApiSession; active: boolean; knowledgeMode: AgentKnowledgeMode }>) {
  const [view, setView] = useState(initial);
  const [review, setReview] = useState<"confirm" | "execute" | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [approvers, setApprovers] = useState<readonly AgentApprover[]>([]);
  const [approver, setApprover] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [uncertain, setUncertain] = useState(false);
  const request = useRef<AbortController | null>(null);
  const execution = useRef<Readonly<{ key: string; version: number }> | null>(null);
  const reviewRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { if (!active) { setPassword(""); setReview(null); setReviewed(false); } }, [active]);
  useEffect(() => { if (review) { reviewRef.current?.focus(); reviewRef.current?.scrollIntoView({ block: "nearest" }); } }, [review]);

  async function run(work: (scope: AgentOperationRequest) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller; setBusy(true); setError(null);
    try { await work({ session, id: view.id, signal: controller.signal, knowledgeMode }); }
    catch (caught) {
      if (!controller.signal.aborted) {
        setError(userMessageOf(caught)); setReview(null);
        if (caught instanceof ApiError && [401, 403, 404].includes(caught.status)) setAvailable(false);
      }
    } finally { request.current = null; setBusy(false); setPassword(""); }
  }

  function accept(next: AgentOperation) {
    setView(next);
    if (next.status === "executed" || next.status === "cancelled" || next.status === "failed") setUncertain(false);
  }

  async function inspect(kind: "confirm" | "execute") {
    setReviewed(false); setApprover(""); setPassword("");
    await run(async scope => {
      const current = await getAgentOperation(scope);
      if (scope.signal.aborted) return;
      accept(current);
      if (kind === "confirm" ? !current.can_confirm : !current.can_execute) return;
      if (kind === "confirm" && current.requires_approval) {
        const choices = await getAgentApprovers(scope);
        if (scope.signal.aborted) return;
        setApprovers(choices);
      }
      setReview(kind);
    });
  }

  async function confirm() {
    if (!reviewed || (view.requires_approval && !approver)) return;
    await run(async scope => {
      const next = await confirmAgentOperation(scope, { expected_version: view.version, ...(view.requires_approval ? { approver_id: approver } : {}) });
      if (!scope.signal.aborted) { accept(next); setReview(null); }
    });
  }

  async function execute() {
    if (view.requires_reauth && !password) return;
    const attempt = execution.current ?? { key: createRequestKey(), version: view.version };
    execution.current = attempt;
    const secret = password;
    setPassword("");
    await run(async scope => {
      try {
        const next = await executeAgentOperation(scope, { ...attempt, ...(view.requires_reauth ? { password: secret } : {}) });
        if (!scope.signal.aborted) { accept(next); setReview(null); }
      } catch (caught) {
        if (!(caught instanceof ApiError) || caught.status >= 500) setUncertain(true);
        else if (!uncertain) execution.current = null;
        throw caught;
      }
    });
  }

  if (!available) return <section className="agent-action" aria-label="작업 접근 불가"><p role="alert">현재 권한으로 이 작업을 확인할 수 없습니다.</p></section>;
  return <section className="agent-action" aria-label={`작업: ${view.preview.title}`}>
    <header><h3>{view.preview.title}</h3><span data-operation-status={view.status}>{STATUS[view.status]}</span></header>
    <small>{view.tool}</small>
    <dl>{view.preview.fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
    {view.preview.warnings.length > 0 && <ul className="agent-action__warnings">{view.preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {view.approval_id && <p>결재 상태: {view.approval_status === "approved" ? "승인" : view.approval_status === "rejected" ? "반려" : "대기"} · 결재 대기 항목 또는 기존 결재 화면에서 결정하세요.</p>}
    {view.status === "executed" && view.result && <details open><summary>실행 결과</summary><pre>{JSON.stringify(view.result, null, 2)}</pre></details>}
    {uncertain && <p role="status">실행 응답을 확인하지 못했습니다. 결과 확인 후 필요하면 같은 요청으로 재시도하세요.</p>}
    <div className="agent-action__controls">
      {view.can_confirm && !review && <Button size="small" disabled={busy} onClick={() => void inspect("confirm")}>검토</Button>}
      {view.can_execute && !review && <Button size="small" disabled={busy} onClick={() => void inspect("execute")}>{uncertain ? "같은 요청 재시도" : "실행 검토"}</Button>}
      <Button size="small" tone="neutral" disabled={busy} onClick={() => void run(async scope => {
        const next = await getAgentOperation(scope);
        if (!scope.signal.aborted) { accept(next); setReview(null); }
      })}>{uncertain ? "결과 확인" : "상태 새로고침"}</Button>
      {view.can_cancel && !uncertain && <Button size="small" tone="danger" disabled={busy} onClick={() => void run(async scope => {
        const next = await cancelAgentOperation(scope, view.version);
        if (!scope.signal.aborted) { accept(next); setReview(null); }
      })}>작업 취소</Button>}
    </div>
    {review && <div className="agent-action__review" ref={reviewRef} tabIndex={-1}>
      {review === "confirm" ? <>
        <label className="agent-action__check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} disabled={busy} />내용을 검토했습니다</label>
        {view.requires_approval && <label>승인자<select aria-label="승인자" value={approver} disabled={busy} onChange={event => setApprover(event.target.value)}>
          <option value="">승인자를 선택하세요</option>{approvers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>{approvers.length === 0 && <small>선택 가능한 승인자가 없습니다.</small>}</label>}
        <Button size="small" disabled={busy || !reviewed || (view.requires_approval && !approver)} onClick={() => void confirm()}>작업 확인</Button>
      </> : <>
        <p>위 내용으로 실제 데이터를 변경합니다.</p>
        {view.requires_reauth && <label>실행 재인증 비밀번호<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>}
        <Button size="small" disabled={busy || (view.requires_reauth && !password)} onClick={() => void execute()}>지금 실행</Button>
      </>}
      <Button size="small" tone="neutral" disabled={busy} onClick={() => { setReview(null); setPassword(""); setReviewed(false); }}>검토 닫기</Button>
    </div>}
    {busy && <p role="status">작업 상태를 확인하는 중입니다...</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
