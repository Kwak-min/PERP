import { useCallback, useRef, useState } from "react";

import { useModalFocus } from "../../hooks/useModalFocus";
import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { Button } from "../ui/Button";

type CreateKind = "task" | "calendar" | "approval" | "dues";
type Option = Readonly<{ id: string; label: string }>;
type Props = Readonly<{
  entityLabel: string;
  kind: CreateKind;
  session: ApiSession;
  options?: readonly Option[];
  onClose: () => void;
  onSaved: (name: string) => void;
}>;

export function QuickCreateModal({ entityLabel, kind, session, options = [], onClose, onSaved }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [secondary, setSecondary] = useState("");
  const [selectedId, setSelectedId] = useState(options[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestClose = useCallback((): void => {
    if (dirty && !window.confirm("입력한 내용이 사라집니다. 닫을까요?")) return;
    onClose();
  }, [dirty, onClose]);
  const dialogRef = useModalFocus<HTMLFormElement>(requestClose, true, inputRef);

  async function submit(): Promise<void> {
    const title = name.trim();
    if (!title) {
      setError("이름을 입력해 주세요.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (kind === "task") {
        await apiRequest("/tasks", { method: "POST", session, body: { title } });
      } else if (kind === "calendar") {
        const start = secondary ? new Date(secondary) : null;
        if (!start || Number.isNaN(start.getTime())) throw new Error("시작 일시를 입력해 주세요.");
        await apiRequest("/calendar", {
          method: "POST",
          session,
          body: { title, calendar: "org", start_at: start.toISOString(), end_at: new Date(start.getTime() + 3_600_000).toISOString() },
        });
      } else if (kind === "approval") {
        if (!selectedId) throw new Error("결재자를 선택해 주세요.");
        await apiRequest("/approvals/requests", { method: "POST", session, body: { title, steps: [{ approver_id: selectedId }] } });
      } else {
        const amount = Number(secondary);
        if (!selectedId) throw new Error("납부 대상을 선택해 주세요.");
        if (!Number.isInteger(amount) || amount < 0) throw new Error("회비 금액을 원 단위 숫자로 입력해 주세요.");
        const rule = await apiRequest("/finance/dues/rules", { method: "POST", session, body: { name: title, amount_minor: amount } });
        if (!rule || typeof rule !== "object" || !("id" in rule) || typeof rule.id !== "string") throw new Error("회비 규칙 응답을 확인할 수 없습니다.");
        await apiRequest("/finance/dues/charges", {
          method: "POST",
          session,
          body: { rule_id: rule.id, payer_ids: [selectedId], due_on: new Date().toISOString().slice(0, 10) },
        });
      }
      onSaved(title);
    } catch (caught: unknown) {
      setError(caught instanceof Error && !("status" in caught) ? caught.message : userMessageOf(caught));
    } finally {
      setSaving(false);
    }
  }

  const secondaryLabel = kind === "calendar" ? "시작 일시" : kind === "dues" ? "금액 (원)" : null;
  const optionLabel = kind === "approval" ? "결재자" : kind === "dues" ? "납부 대상" : null;
  return (
    <div className="modal-scrim" role="presentation" onMouseDown={requestClose}>
      <form ref={dialogRef} className="modal quick-create-modal" role="dialog" aria-modal="true" aria-labelledby="quick-create-title"
        onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <header className="modal__head"><div><span className="eyebrow">새 항목</span><h2 id="quick-create-title">{entityLabel} 만들기</h2><p>저장하면 조직 데이터에 즉시 반영됩니다.</p></div>
          <Button tone="neutral" size="small" type="button" onClick={requestClose} aria-label="창 닫기">닫기</Button></header>
        <label className="field"><span>이름</span><input ref={inputRef} value={name} required aria-invalid={Boolean(error)} placeholder={`${entityLabel} 이름`}
          onChange={(event) => { setName(event.target.value); setDirty(true); setError(null); }} /></label>
        {secondaryLabel && <label className="field"><span>{secondaryLabel}</span><input type={kind === "calendar" ? "datetime-local" : "number"} min={kind === "dues" ? "0" : undefined}
          value={secondary} required onChange={(event) => { setSecondary(event.target.value); setDirty(true); }} /></label>}
        {optionLabel && <label className="field"><span>{optionLabel}</span><select value={selectedId} required onChange={(event) => { setSelectedId(event.target.value); setDirty(true); }}>
          <option value="">선택</option>{options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>}
        {error && <div className="form-error" role="alert" id="quick-create-error">{error}</div>}
        <footer className="modal__actions"><Button tone="neutral" type="button" onClick={requestClose}>취소</Button><Button type="submit" disabled={saving}>{saving ? "저장 중" : "만들기"}</Button></footer>
      </form>
    </div>
  );
}
