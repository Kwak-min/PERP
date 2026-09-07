import { useEffect, useRef, useState } from "react";

import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { useModalFocus } from "../../hooks/useModalFocus";
import type { CreateConfig } from "../../routes/catalog";
import { Button } from "../ui/Button";

type Props = Readonly<{
  entityLabel: string;
  config: CreateConfig;
  session: ApiSession | null;
  onClose: () => void;
  onCreated: () => void;
  method?: "POST" | "PATCH";
  initialValues?: Record<string, string>;
}>;

// 설정(CreateConfig)에 따라 입력 폼을 렌더하고 perp_db 로 생성/수정 요청을 보낸다.
export function CreateFormModal({ entityLabel, config, session, onClose, onCreated, method = "POST", initialValues }: Props) {
  const firstRef = useRef<HTMLInputElement>(null);
  const isEdit = method === "PATCH";
  const [values, setValues] = useState<Record<string, string>>(initialValues ?? {});
  const [options, setOptions] = useState<Record<string, readonly { value: string; label: string }[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // select 필드의 옵션을 엔드포인트에서 가져온다.
  useEffect(() => {
    let alive = true;
    for (const field of config.fields) {
      if (field.type !== "select" || !field.optionsEndpoint) continue;
      apiRequest(field.optionsEndpoint, { ...(session ? { session } : {}) })
        .then((data) => {
          if (!alive) return;
          const items = (data as { items?: readonly { value: string; label: string }[] }).items ?? [];
          setOptions((prev) => ({ ...prev, [field.name]: items }));
        })
        .catch((caught: unknown) => {
          if (alive) setError(userMessageOf(caught));
        });
    }
    return () => {
      alive = false;
    };
  }, [config.fields, session]);

  const dirty = Object.entries(values).some(([key, value]) => value !== (initialValues?.[key] ?? ""));

  function requestClose(): void {
    if (dirty && !window.confirm("입력한 내용이 사라집니다. 닫을까요?")) return;
    onClose();
  }

  const dialogRef = useModalFocus<HTMLFormElement>(requestClose, true, firstRef);

  function set(name: string, value: string): void {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    for (const field of config.fields) {
      if (field.required && !(values[field.name] ?? "").trim()) {
        setError(`${field.label}을(를) 입력해 주세요.`);
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      await apiRequest(config.endpoint, {
        method,
        body: values,
        ...(session ? { session } : {}),
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(userMessageOf(err));
      setSaving(false);
    }
  }

  return (
    <div className="modal-scrim" role="presentation" onMouseDown={requestClose}>
      <form
        ref={dialogRef}
        className="modal quick-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-form-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <header className="modal__head">
          <div>
            <span className="eyebrow">{isEdit ? "항목 수정" : "새 항목"}</span>
            <h2 id="create-form-title">{entityLabel} {isEdit ? "수정" : "만들기"}</h2>
            <p>필수 정보를 입력해 저장합니다.</p>
          </div>
          <Button tone="ghost" size="small" type="button" onClick={requestClose}>닫기</Button>
        </header>
        <div className="form-stack">
          {config.fields.map((field, index) => (
            <label key={field.name}>
              {field.label}{field.required ? " *" : ""}
              {field.type === "textarea" ? (
                <textarea
                  value={values[field.name] ?? ""}
                  onChange={(event) => set(field.name, event.target.value)}
                />
              ) : field.type === "select" ? (
                <select
                  value={values[field.name] ?? ""}
                  onChange={(event) => set(field.name, event.target.value)}
                >
                  <option value="">선택하세요</option>
                  {(options[field.name] ?? []).map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  ref={index === 0 ? firstRef : undefined}
                  type={field.type === "text" ? "text" : field.type}
                  value={values[field.name] ?? ""}
                  onChange={(event) => set(field.name, event.target.value)}
                />
              )}
            </label>
          ))}
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}
        <footer className="modal__foot">
          <Button tone="ghost" type="button" onClick={requestClose}>취소</Button>
          <Button type="submit" disabled={saving}>{saving ? "저장 중…" : isEdit ? "저장" : "만들기"}</Button>
        </footer>
      </form>
    </div>
  );
}
