import { useRef, useState } from "react";
import { useModalFocus } from "../../hooks/useModalFocus";
import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { isPgWorkspace } from "../../services/workspace";
import { Button } from "../ui/Button";
import { calendarInputSchema, localDateInput } from "./calendarModel";

export function CalendarCreateModal({ session, shown, onClose, onSaved }: Readonly<{
  session: ApiSession; shown: Date; onClose: () => void; onSaved: (start: Date) => void;
}>) {
  const firstRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [start, setStart] = useState(`${localDateInput(shown)}T09:00`);
  const [end, setEnd] = useState(`${localDateInput(shown)}T10:00`);
  const [location, setLocation] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function requestClose(): void {
    if (saving || (dirty && !window.confirm("입력한 내용이 사라집니다. 닫을까요?"))) return;
    onClose();
  }
  const dialogRef = useModalFocus<HTMLFormElement>(requestClose, true, firstRef);
  async function submit(): Promise<void> {
    const parsed = calendarInputSchema.safeParse({ title, start, end, location });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "입력을 확인해 주세요"); return; }
    setSaving(true); setError(null);
    const value = parsed.data;
    const pg = isPgWorkspace(session.orgId);
    try {
      await apiRequest(pg ? "/pg/calendar" : "/calendar", { method: "POST", session, body: {
        title: value.title, location: pg ? value.location : value.location || null,
        ...(pg ? { starts_at: value.start.toISOString(), ends_at: value.end.toISOString() }
          : { calendar: "org", start_at: value.start.toISOString(), end_at: value.end.toISOString() }),
      } });
      onSaved(value.start);
    } catch (caught: unknown) { setError(userMessageOf(caught)); setSaving(false); }
  }
  return <div className="modal-scrim" role="presentation" onMouseDown={requestClose}>
    <form ref={dialogRef} className="modal quick-create-modal" role="dialog" aria-modal="true" aria-labelledby="calendar-create-title"
      onMouseDown={event => event.stopPropagation()} onChange={() => setDirty(true)} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <header className="modal__head"><div><h2 id="calendar-create-title">일정 만들기</h2><p>일시는 기기 시간대 기준으로 저장합니다.</p></div><Button type="button" tone="neutral" onClick={requestClose} disabled={saving}>닫기</Button></header>
      <div className="form-stack">
        <label>제목<input ref={firstRef} name="title" required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
        <label>시작<input name="start" type="datetime-local" required value={start} onChange={event => setStart(event.target.value)} /></label>
        <label>종료<input name="end" type="datetime-local" required value={end} onChange={event => setEnd(event.target.value)} /></label>
        <label>장소<input name="location" value={location} onChange={event => setLocation(event.target.value)} /></label>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <footer className="modal__foot"><Button type="button" tone="neutral" disabled={saving} onClick={requestClose}>취소</Button><Button type="submit" disabled={saving}>{saving ? "저장 중" : "만들기"}</Button></footer>
    </form>
  </div>;
}
