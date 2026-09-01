import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/Button";
import { useModalFocus } from "../../hooks/useModalFocus";

type Props = Readonly<{
  entityLabel: string;
  mode: "create" | "edit";
  onClose: () => void;
  onSubmit: (name: string) => void;
}>;

export function QuickCreateModal({ entityLabel, mode, onClose, onSubmit }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalFocus<HTMLFormElement>(onClose);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function requestClose(): void {
    if (name.trim() && !window.confirm("입력한 내용이 사라집니다. 닫을까요?")) return;
    onClose();
  }

  useEffect(() => {
    inputRef.current?.focus();
    return undefined;
  }, [onClose]);

  return (
    <div className="modal-scrim" role="presentation" onMouseDown={requestClose}>
      <form
        ref={dialogRef}
        className="modal quick-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-create-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) {
            setError("이름을 입력해 주세요.");
            return;
          }
          onSubmit(trimmed);
        }}
      >
        <header className="modal__head">
          <div>
            <span className="eyebrow">{mode === "create" ? "새 항목" : "항목 편집"}</span>
            <h2 id="quick-create-title">{entityLabel} {mode === "create" ? "만들기" : "편집"}</h2>
            <p>필수 정보를 입력해 작업을 계속합니다.</p>
          </div>
          <Button tone="neutral" size="small" type="button" onClick={requestClose} aria-label="창 닫기">닫기</Button>
        </header>
        <label className="field">
          <span>이름</span>
          <input
            ref={inputRef}
            value={name}
            required
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "quick-create-error" : undefined}
            placeholder={`${entityLabel} 이름`}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />
          {error && <small className="field-error" id="quick-create-error">{error}</small>}
        </label>
        <footer className="modal__actions">
          <Button tone="neutral" type="button" onClick={requestClose}>취소</Button>
          <Button type="submit">{mode === "create" ? "만들기" : "저장"}</Button>
        </footer>
      </form>
    </div>
  );
}
