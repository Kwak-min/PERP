import { useState } from "react";

import { Button } from "../../components/ui/Button";
import { LEAVE_KIND_LABELS } from "./model";

type Props = Readonly<{
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: Readonly<{ kind: string; start_on: string; end_on: string; reason: string }>) => void;
}>;

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** 기간·종류는 기본값으로 채워두고, 사유만 적으면 바로 결재로 올라간다. */
export function LeaveRequestForm({ busy, onCancel, onSubmit }: Props) {
  const [kind, setKind] = useState("annual");
  const [startOn, setStartOn] = useState(todayIso);
  const [endOn, setEndOn] = useState(todayIso);
  const [reason, setReason] = useState("");

  return (
    <form
      className="leave-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ kind, start_on: startOn, end_on: endOn, reason: reason.trim() });
      }}
    >
      <div className="leave-form__head">
        <div>
          <h3>휴가 신청</h3>
          <p>사유만 적으면 결재선으로 바로 올라갑니다. 기간과 종류는 필요할 때만 바꾸세요.</p>
        </div>
        <Button tone="neutral" size="small" onClick={onCancel}>닫기</Button>
      </div>
      <div className="leave-form__fields">
        <label>
          종류
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            {Object.entries(LEAVE_KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          시작일
          <input type="date" value={startOn} onChange={(event) => setStartOn(event.target.value)} required />
        </label>
        <label>
          종료일
          <input type="date" value={endOn} onChange={(event) => setEndOn(event.target.value)} required />
        </label>
      </div>
      <label className="leave-form__reason">
        사유
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          placeholder="예: 개인 사유로 연차 사용"
          required
          autoFocus
        />
      </label>
      <div className="leave-form__actions">
        <Button type="submit" disabled={busy || reason.trim() === "" || endOn < startOn}>
          {busy ? "신청 중…" : "결재 올리기"}
        </Button>
      </div>
    </form>
  );
}
