import { useEffect, useId, type ReactNode } from "react";
import { useModalFocus } from "../../hooks/useModalFocus";

type Props = Readonly<{ title: string; onClose: () => void; busy?: boolean; wide?: boolean; children: ReactNode }>;

export function ReservationModal({ title, onClose, busy = false, wide = false, children }: Props) {
  const ref = useModalFocus<HTMLDialogElement>(() => { if (!busy) onClose(); });
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled])')?.focus();
    return () => dialog?.close();
  }, [ref]);
  return <dialog ref={ref} className={`rsv-modal${wide ? " rsv-modal-wide" : ""}`} aria-labelledby={titleId} aria-modal="true"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (!busy && event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) onClose();
    }}>
    <div className="rsv-modal-header">
      <h2 id={titleId} className="rsv-modal-title">{title}</h2>
      <button type="button" className="rsv-modal-close" onClick={onClose} disabled={busy} aria-label="닫기">×</button>
    </div>
    {children}
  </dialog>;
}
