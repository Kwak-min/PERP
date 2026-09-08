import { useEffect, useId, useState } from "react";
import { addAttendee, getAttendees, removeAttendee } from "../../services/reservationApi";
import { attendeeSchema, ATTENDEE_STATUS_LABEL, type Attendee, type AddAttendeeInput } from "./model";

interface AttendeePanelProps {
  reservationId: number;
  readonly?: boolean;
}

const ST_BG: Record<string, string> = {
  INVITED: "var(--of-warning-soft, #fffbeb)",
  ACCEPTED: "var(--of-success-soft, #f0fdf4)",
  DECLINED: "var(--of-danger-soft, #fef2f2)",
};
const ST_FG: Record<string, string> = {
  INVITED: "var(--of-warning, #b45309)",
  ACCEPTED: "var(--of-success, #15803d)",
  DECLINED: "var(--of-danger, #b91c1c)",
};

export function AttendeePanel({ reservationId, readonly = false }: Readonly<AttendeePanelProps>) {
  const formId = useId();
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<AddAttendeeInput>({ name: "", email: "", department: "" });

  const load = async () => {
    try {
      setLoading(true);
      const raw = await getAttendees(reservationId);
      setAttendees(Array.isArray(raw) ? raw.map((i) => attendeeSchema.parse(i)) : []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "참석자 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [reservationId]);

  const handleAdd = async () => {
    if (!form.name || !form.email) { setAddError("이름과 이메일을 입력해주세요."); return; }
    try {
      setBusy(true);
      setAddError(null);
      await addAttendee(reservationId, { ...form, department: form.department || undefined });
      setForm({ name: "", email: "", department: "" });
      await load();
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : "참석자 초대에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (id: number) => {
    if (!confirm("참석자를 제거하시겠습니까?")) return;
    try {
      setBusy(true);
      await removeAttendee(reservationId, id);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "참석자 제거에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 style={{ fontSize: "0.9rem", fontWeight: 600, marginBottom: "0.75rem", color: "var(--of-text, #0f172a)" }}>
        참석자 ({attendees.length}명)
      </h3>
      {error && <div className="rsv-error-banner">{error}</div>}
      {loading ? (
        <p style={{ fontSize: "0.8rem", color: "var(--of-text-faint, #64748b)" }}>불러오는 중...</p>
      ) : attendees.length === 0 ? (
        <div className="rsv-empty" style={{ padding: "1rem" }}>
          <div className="rsv-empty-text">초대된 참석자가 없습니다.</div>
        </div>
      ) : (
        <div className="rsv-attendee-list">
          {attendees.map((a) => (
            <div key={a.id} className="rsv-attendee-row">
              <div className="rsv-attendee-info">
                <div className="rsv-attendee-name">{a.name}</div>
                <div className="rsv-attendee-email">{a.email}{a.department ? ` · ${a.department}` : ""}</div>
              </div>
              <span style={{ fontSize: "0.7rem", padding: "0.15rem 0.45rem", borderRadius: "99px", background: ST_BG[a.status], color: ST_FG[a.status] }}>
                {ATTENDEE_STATUS_LABEL[a.status]}
              </span>
              {!readonly && (
                <button className="btn btn-ghost" style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }} onClick={() => void handleRemove(a.id)} disabled={busy}>
                  제거
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {!readonly && (
        <div style={{ borderTop: "1px solid var(--of-border, #e2e8f0)", marginTop: "1rem", paddingTop: "1rem" }}>
          <p style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.75rem", color: "var(--of-text-muted, #5b6b80)" }}>
            참석자 초대
          </p>
          {addError && <div className="rsv-error-banner">{addError}</div>}
          <div className="rsv-form-row" style={{ marginBottom: "0.5rem" }}>
            <div className="rsv-form-group" style={{ margin: 0 }}>
              <label htmlFor={`${formId}-name`}>이름 *</label>
              <input id={`${formId}-name`} type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="홍길동" />
            </div>
            <div className="rsv-form-group" style={{ margin: 0 }}>
              <label htmlFor={`${formId}-department`}>부서</label>
              <input id={`${formId}-department`} type="text" value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} placeholder="개발팀" />
            </div>
          </div>
          <div className="rsv-form-group" style={{ marginBottom: "0.75rem" }}>
            <label htmlFor={`${formId}-email`}>이메일 *</label>
            <input id={`${formId}-email`} type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="name@example.com" />
          </div>
          <button className="btn btn-primary" onClick={() => void handleAdd()} disabled={busy} style={{ width: "100%" }}>
            {busy ? "초대 중..." : "초대 이메일 발송"}
          </button>
        </div>
      )}
    </div>
  );
}