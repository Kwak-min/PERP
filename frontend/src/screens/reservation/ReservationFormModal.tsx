import { useState } from "react";
import type {
  CreateReservationInput,
  UpdateReservationInput,
  Reservation,
  RecurrenceInput,
} from "./model";
import { FREQUENCY_LABEL } from "./model";

interface ReservationFormModalProps {
  /** ? :  ? ?. ??? . */
  existing?: Reservation;
  /** ? ?   ?*/
  spaceId?: number;
  prefillStart?: string; // ISO
  prefillEnd?: string;   // ISO
  onSubmit: (dto: CreateReservationInput | UpdateReservationInput) => Promise<void>;
  onClose: () => void;
}

function toDatetimeLocal(iso: string): string {
  // datetime-local input value ?: "YYYY-MM-DDTHH:mm"
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

  //  ? (?  ?)
  const [useRecurrence, setUseRecurrence] = useState(false);
  const [recurrence, setRecurrence] = useState<RecurrenceInput>({
    frequency: "WEEKLY",
    interval: 1,
  });

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim()) { setError("??????."); return; }
    if (!startTime || !endTime) { setError("?/ ??????."); return; }
    if (new Date(endTime) <= new Date(startTime)) {
      setError(" ?? ? ? ?? ???");
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
        };
        await onSubmit(dto);
      }
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "?? ???.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rsv-modal-backdrop" onClick={onClose}>
      <div className="rsv-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rsv-modal-header">
          <h2 className="rsv-modal-title">{isEdit ? "? ?" : "? ?"}</h2>
          <button className="rsv-modal-close" onClick={onClose} aria-label="close">X</button>
        </div>

        {error && <div className="rsv-error-banner">{error}</div>}

        <div className="rsv-form-group">
          <label>? *</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="? ??????"
            autoFocus
          />
        </div>

        <div className="rsv-form-group">
          <label>?</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="?, ? ? ???"
          />
        </div>

        <div className="rsv-form-row">
          <div className="rsv-form-group">
            <label>? ? *</label>
            <input
              type="datetime-local"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>
          <div className="rsv-form-group">
            <label> ? *</label>
            <input
              type="datetime-local"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
            />
          </div>
        </div>

        {!isEdit && (
          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontSize: "0.875rem", color: "var(--of-text, #0f172a)" }}>
              <input
                type="checkbox"
                checked={useRecurrence}
                onChange={(e) => setUseRecurrence(e.target.checked)}
              />
               ? ?
            </label>

            {useRecurrence && (
              <div style={{ marginTop: "0.75rem", padding: "1rem", background: "var(--of-surface-muted, #f1f5f9)", borderRadius: "8px", border: "1px solid var(--of-border, #e2e8f0)" }}>
                <div className="rsv-form-row">
                  <div className="rsv-form-group" style={{ margin: 0 }}>
                    <label> </label>
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
                    <label> (?)</label>
                    <input
                      type="number"
                      min={1}
                      value={recurrence.interval}
                      onChange={(e) => setRecurrence((r) => ({ ...r, interval: Number(e.target.value) }))}
                    />
                  </div>
                </div>
                <div className="rsv-form-group" style={{ marginBottom: 0, marginTop: "0.5rem" }}>
                  <label> ? (?)</label>
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
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}></button>
          <button className="btn btn-primary" onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? "????.." : isEdit ? "??" : "??"}
          </button>
        </div>
      </div>
    </div>
  );
}
