import { useState } from "react";
import type { CancelScope } from "./model";

interface CancelScopeModalProps {
  isRecurring: boolean;
  onConfirm: (scope: CancelScope) => void;
  onClose: () => void;
  busy?: boolean;
}

const ALL_OPTIONS: { value: CancelScope; label: string; desc: string }[] = [
  { value: "THIS", label: "이 예약만 취소", desc: "선택한 날짜의 예약 1건만 취소됩니다." },
  { value: "THIS_AND_FOLLOWING", label: "이 예약 및 이후 예약 모두 취소", desc: "이 예약부터 이후 모든 예약이 취소됩니다." },
  { value: "ALL", label: "전체 반복 예약 취소", desc: "이 반복 계열의 모든 예약이 취소됩니다." },
];

const THIS_ONLY: { value: CancelScope; label: string; desc: string }[] = [
  { value: "THIS", label: "이 예약만 취소", desc: "선택한 날짜의 예약 1건만 취소됩니다." },
];

export function CancelScopeModal({ isRecurring, onConfirm, onClose, busy = false }: Readonly<CancelScopeModalProps>) {
  const [scope, setScope] = useState<CancelScope>("THIS");
  const options = isRecurring ? ALL_OPTIONS : THIS_ONLY;

  return (
    <div className="rsv-modal-backdrop" onClick={onClose}>
      <div className="rsv-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rsv-modal-header">
          <h2 className="rsv-modal-title">예약 취소</h2>
          <button className="rsv-modal-close" onClick={onClose} aria-label="닫기">X</button>
        </div>
        {isRecurring && (
          <p style={{ fontSize: "0.875rem", color: "var(--of-text-muted, #5b6b80)", marginBottom: "1rem" }}>
            반복 예약입니다. 취소 범위를 선택해주세요.
          </p>
        )}
        <div className="rsv-scope-options">
          {options.map((opt) => (
            <label key={opt.value} className={`rsv-scope-option ${scope === opt.value ? "selected" : ""}`}>
              <input type="radio" name="cancelScope" value={opt.value} checked={scope === opt.value} onChange={() => setScope(opt.value)} />
              <div>
                <div className="rsv-scope-label">{opt.label}</div>
                <div className="rsv-scope-desc">{opt.desc}</div>
              </div>
            </label>
          ))}
        </div>
        <div className="rsv-modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>돌아가기</button>
          <button className="btn btn-danger" onClick={() => onConfirm(scope)} disabled={busy}>
            {busy ? "취소 중..." : "예약 취소"}
          </button>
        </div>
      </div>
    </div>
  );
}