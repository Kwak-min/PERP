import { useState } from "react";
import type {
  CreateReservationInput,
  UpdateReservationInput,
  Reservation,
  RecurrenceInput,
  CreateAttendeeItem,
} from "./model";
import { FREQUENCY_LABEL } from "./model";

interface ReservationFormModalProps {
  /** 수정 모드: 기존 예약 전달. 없으면 생성 모드. */
  existing?: Reservation;
  /** 생성 모드에서 미리 채울 값 */
  spaceId?: number;
  prefillStart?: string; // ISO
  prefillEnd?: string;   // ISO
  onSubmit: (dto: CreateReservationInput | UpdateReservationInput) => Promise<void>;
  onClose: () => void;
}

function toDatetimeLocal(iso: string): string {
  return iso.slice(0, 16);
}

function fromDatetimeLocal(val: string): string {
  return new Date(val).toISOString();
}

export function ReservationFormModal({
  existing,
  spaceId,
  prefillStart,
  prefillEnd,
  onSubmit,
  onClose,
}: Readonly<ReservationFormModalProps>) {
  const isEdit = Boolean(existing);

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
    if (new Date(endTime) <= new Date(startTime)) {
      setError("종료 시간은 시작 시간 이후여야 합니다.");
      return;
    }
    try {
      setBusy(true);
      setError(null);
      if (isEdit) {
        const dto: UpdateReservationInput = {
          title: title || undefined,
          description: description || undefined,
          startTime: fromDatetimeLocal(startTime),
          endTime: fromDatetimeLocal(endTime),
        };
        await onSubmit(dto);
      } else {
        const dto: CreateReservationInput = {
          spaceId: spaceId!,
          title,
          description: description || undefined,
          startTime: fromDatetimeLocal(startTime),
          endTime: fromDatetimeLocal(endTime),
          recurrence: useRecurrence ? recurrence : undefined,
          attendees: attendees.length > 0 ? attendees : undefined,
        };
        await onSubmit(dto);
      }
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rsv-modal-backdrop" onClick={onClose}>
      <div className="rsv-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rsv-modal-header">
          <h2 className="rsv-modal-title">{isEdit ? "예약 수정" : "예약 생성"}</h2>
          <button className="rsv-modal-close" onClick={onClose} aria-label="close">✕</button>
        </div>

        {error && <div className="rsv-error-banner">{error}</div>}

        <div className="rsv-form-group">
          <label>제목 *</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="회의 제목을 입력해주세요"
            autoFocus
          />
        </div>

        <div className="rsv-form-group">
          <label>설명</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="안건, 참고사항 등을 입력해주세요"
          />
        </div>

        <div className="rsv-form-row">
          <div className="rsv-form-group">
            <label>시작 시간 *</label>
            <input
              type="datetime-local"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>
          <div className="rsv-form-group">
            <label>종료 시간 *</label>
            <input
              type="datetime-local"
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
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
              <input
                type="text"
                placeholder="이름 (예: 홍길동)"
                value={attName}
                onChange={(e) => setAttName(e.target.value)}
                style={{ flex: "1" }}
              />
              <input
                type="email"
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
                  <span
                    key={`${a.email}-${idx}`}
                    className="rsv-amenity-badge"
                    style={{ background: "var(--of-primary-soft, #eef2ff)", color: "var(--of-primary, #4f46e5)", border: "1px solid #c7d2fe", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
                    onClick={() => handleRemoveAttendee(idx)}
                  >
                    {a.name} ({a.email}) <span style={{ fontWeight: 700 }}>✕</span>
                  </span>
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
                    <label>반복 주기</label>
                    <select
                      value={recurrence.frequency}
                      onChange={(e) => setRecurrence((r) => ({ ...r, frequency: e.target.value as RecurrenceInput["frequency"] }))}
                    >
                      {Object.entries(FREQUENCY_LABEL).map(([val, label]) => (
                        <option key={val} value={val}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="rsv-form-group" style={{ margin: 0 }}>
                    <label>간격 (횟수)</label>
                    <input
                      type="number"
                      min={1}
                      value={recurrence.interval}
                      onChange={(e) => setRecurrence((r) => ({ ...r, interval: Number(e.target.value) }))}
                    />
                  </div>
                </div>
                <div className="rsv-form-group" style={{ marginBottom: 0, marginTop: "0.5rem" }}>
                  <label>종료 날짜 (선택)</label>
                  <input
                    type="date"
                    value={recurrence.endDate ?? ""}
                    onChange={(e) => setRecurrence((r) => ({ ...r, endDate: e.target.value || undefined }))}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        <div className="rsv-modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>취소</button>
          <button className="btn btn-primary" onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? "저장 중..." : isEdit ? "수정하기" : "예약하기"}
          </button>
        </div>
      </div>
    </div>
  );
}
