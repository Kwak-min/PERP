import { useId, useState } from "react";
import { ReservationApiError } from "../../services/reservationApi";
import { ReservationModal } from "./ReservationModal";
import { ConflictAvailability } from "./ConflictAvailability";
import { fromDatetimeLocal, toDatetimeLocal } from "./formTime";
import type {
  CreateReservationInput,
  UpdateReservationInput,
  Reservation,
  RecurrenceInput,
  CreateAttendeeItem,
} from "./model";
import { FREQUENCY_LABEL, recurrenceFrequencySchema } from "./model";

type ReservationFormModalProps = Readonly<{
  onClose: () => void; onRefresh: () => void;
}> & (Readonly<{
  existing: Reservation; onSubmit: (dto: UpdateReservationInput) => Promise<void>;
}> | Readonly<{
  spaceId: number; prefillStart?: string; prefillEnd?: string;
  onSubmit: (dto: CreateReservationInput) => Promise<void>;
}>);

export function ReservationFormModal(props: ReservationFormModalProps) {
  const { onClose, onRefresh } = props;
  const existing = "existing" in props ? props.existing : undefined;
  const prefillStart = "spaceId" in props ? props.prefillStart : undefined;
  const prefillEnd = "spaceId" in props ? props.prefillEnd : undefined;
  const isEdit = Boolean(existing);
  const formId = useId();

  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [startTime, setStartTime] = useState(
    existing ? toDatetimeLocal(existing.startTime) : (prefillStart ? toDatetimeLocal(prefillStart) : ""),
  );
  const [endTime, setEndTime] = useState(
    existing ? toDatetimeLocal(existing.endTime) : (prefillEnd ? toDatetimeLocal(prefillEnd) : ""),
  );

  // 반복 설정 (생성 모드 전용)
  const [useRecurrence, setUseRecurrence] = useState(false);
  const [recurrence, setRecurrence] = useState<RecurrenceInput>({
    frequency: "WEEKLY",
    interval: 1,
  });

  // 참석자 개별 입력 (생성 모드 전용)
  const [attendees, setAttendees] = useState<CreateAttendeeItem[]>([]);
  const [attName, setAttName] = useState("");
  const [attEmail, setAttEmail] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);

  const handleAddAttendee = () => {
    if (!attName.trim() || !attEmail.trim()) return;
    if (!attEmail.includes("@")) {
      setError("유효한 이메일을 입력해주세요.");
      return;
    }
    setError(null);
    setAttendees((prev) => [...prev, { name: attName.trim(), email: attEmail.trim() }]);
    setAttName("");
    setAttEmail("");
  };

  const handleRemoveAttendee = (idx: number) => {
    setAttendees((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    if (!title.trim()) { setError("제목을 입력해주세요."); return; }
    if (!startTime || !endTime) { setError("시작/종료 시간을 입력해주세요."); return; }
    if (Date.parse(fromDatetimeLocal(endTime)) <= Date.parse(fromDatetimeLocal(startTime))) {
      setError("종료 시간은 시작 시간 이후여야 합니다.");
      return;
    }
    try {
      setBusy(true);
      setError(null);
      setErrorStatus(null);
      if ("existing" in props) {
        const dto: UpdateReservationInput = {
          title: title || undefined,
          description: description || undefined,
          startTime: fromDatetimeLocal(startTime),
          endTime: fromDatetimeLocal(endTime),
        };
        await props.onSubmit(dto);
      } else {
        const dto: CreateReservationInput = {
          spaceId: props.spaceId,
          title,
          description: description || undefined,
          startTime: fromDatetimeLocal(startTime),
          endTime: fromDatetimeLocal(endTime),
          recurrence: useRecurrence ? recurrence : undefined,
          attendees: attendees.length > 0 ? attendees : undefined,
        };
        await props.onSubmit(dto);
      }
      onClose();
    } catch (e: unknown) {
      setErrorStatus(e instanceof ReservationApiError ? e.status : null);
      setError(e instanceof Error ? e.message : "저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ReservationModal title={isEdit ? "예약 수정" : "예약 생성"} onClose={onClose} busy={busy}>
        <p className="rsv-calendar-hint">모든 입력 시간은 서울 시간 (Asia/Seoul)입니다.</p>
        {error && <div className="rsv-error-banner" role="alert" data-error-status={errorStatus}>
          {errorStatus === 409 && <p>선택한 시간에 다른 예약이 있습니다. 입력은 유지됩니다. 현황을 새로고침하고 시간을 수정해주세요.</p>}
          {error}
          {errorStatus === 409 && startTime && <ConflictAvailability key={startTime.slice(0, 10)}
            spaceId={"existing" in props ? props.existing.spaceId : props.spaceId} day={startTime.slice(0, 10)} onRefresh={onRefresh} />}
        </div>}
        <form onSubmit={event => { event.preventDefault(); void handleSubmit(); }}>
        <fieldset disabled={busy} className="rsv-form-fields">

        <div className="rsv-form-group">
          <label htmlFor={`${formId}-title`}>제목 *</label>
          <input
            id={`${formId}-title`} required type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="회의 제목을 입력해주세요"
            autoFocus
          />
        </div>

        <div className="rsv-form-group">
          <label htmlFor={`${formId}-description`}>설명</label>
          <textarea id={`${formId}-description`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="안건, 참고사항 등을 입력해주세요"
          />
        </div>

        <div className="rsv-form-row rsv-time-fields">
          <div className="rsv-form-group">
            <label htmlFor={`${formId}-start`}>시작 시간 *</label>
            <input
              id={`${formId}-start`} required step="0.001" type="datetime-local"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>
          <div className="rsv-form-group">
            <label htmlFor={`${formId}-end`}>종료 시간 *</label>
            <input
              id={`${formId}-end`} required step="0.001" type="datetime-local"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
            />
          </div>
        </div>

        {/* 참석자 동시 초대 (생성 모드 전용) */}
        {!isEdit && (
          <div style={{ marginBottom: "1rem" }}>
            <label style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--of-text-muted, #475569)", display: "block", marginBottom: "0.35rem" }}>
              참석자 초대 (생성 시 초대 메일 및 .ics 캘린더 파일 자동 발송)
            </label>
            <div className="rsv-attendee-inputs">
              <input aria-label="참석자 이름"
                type="text"
                placeholder="이름 (예: 홍길동)"
                value={attName}
                onChange={(e) => setAttName(e.target.value)}
                style={{ flex: "1" }}
              />
              <input
                type="email" aria-label="참석자 이메일"
                placeholder="이메일 (예: user@example.com)"
                value={attEmail}
                onChange={(e) => setAttEmail(e.target.value)}
                style={{ flex: "1.5" }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddAttendee();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleAddAttendee}
                style={{ whiteSpace: "nowrap" }}
              >
                + 추가
              </button>
            </div>

            {attendees.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.5rem" }}>
                {attendees.map((a, idx) => (
                  <button type="button" aria-label={`${a.name} 초대 제거`}
                    key={`${a.email}-${idx}`}
                    className="rsv-amenity-badge"
                    style={{ background: "var(--of-primary-soft, #eef2ff)", color: "var(--of-primary, #4f46e5)", border: "1px solid #c7d2fe", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
                    onClick={() => handleRemoveAttendee(idx)}
                  >
                    {a.name} ({a.email}) <span style={{ fontWeight: 700 }}>✕</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!isEdit && (
          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontSize: "0.875rem", color: "var(--of-text, #0f172a)" }}>
              <input
                type="checkbox"
                checked={useRecurrence}
                onChange={(e) => setUseRecurrence(e.target.checked)}
              />
              반복 예약 설정
            </label>

            {useRecurrence && (
              <div style={{ marginTop: "0.75rem", padding: "1rem", background: "var(--of-surface-muted, #f1f5f9)", borderRadius: "8px", border: "1px solid var(--of-border, #e2e8f0)" }}>
                <div className="rsv-form-row">
                  <div className="rsv-form-group" style={{ margin: 0 }}>
                    <label htmlFor={`${formId}-frequency`}>반복 주기</label>
                    <select id={`${formId}-frequency`}
                      value={recurrence.frequency}
                      onChange={(e) => setRecurrence((r) => ({ ...r, frequency: recurrenceFrequencySchema.parse(e.target.value) }))}
                    >
                      {Object.entries(FREQUENCY_LABEL).map(([val, label]) => (
                        <option key={val} value={val}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="rsv-form-group" style={{ margin: 0 }}>
                    <label htmlFor={`${formId}-interval`}>간격 (횟수)</label>
                    <input
                      id={`${formId}-interval`} required type="number"
                      min={1}
                      value={recurrence.interval}
                      onChange={(e) => setRecurrence((r) => ({ ...r, interval: Number(e.target.value) }))}
                    />
                  </div>
                </div>
                <div className="rsv-form-group" style={{ marginBottom: 0, marginTop: "0.5rem" }}>
                  <label htmlFor={`${formId}-until`}>종료 날짜 (선택)</label>
                  <input
                    id={`${formId}-until`} type="date"
                    value={recurrence.endDate ?? ""}
                    onChange={(e) => setRecurrence((r) => ({ ...r, endDate: e.target.value || undefined }))}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        <div className="rsv-modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>취소</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "저장 중..." : isEdit ? "수정하기" : "예약하기"}
          </button>
        </div>
        </fieldset>
        </form>
    </ReservationModal>
  );
}
