import { useState } from "react";
import type { CreateSpaceInput } from "./model";

interface SpaceFormModalProps {
  existing?: { id: number; name: string; location: string; floor?: string | null; capacity: number; amenities?: string[] | null };
  onSubmit: (dto: CreateSpaceInput) => Promise<void>;
  onClose: () => void;
}

export function SpaceFormModal({ existing, onSubmit, onClose }: Readonly<SpaceFormModalProps>) {
  const isEdit = Boolean(existing);

  const [name, setName] = useState(existing?.name ?? "");
  const [location, setLocation] = useState(existing?.location ?? "");
  const [floor, setFloor] = useState(existing?.floor ?? "");
  const [capacity, setCapacity] = useState(String(existing?.capacity ?? ""));
  const [amenityInput, setAmenityInput] = useState("");
  const [amenities, setAmenities] = useState<string[]>(existing?.amenities ?? []);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const addAmenity = () => {
    const val = amenityInput.trim();
    if (val && !amenities.includes(val)) {
      setAmenities((a) => [...a, val]);
    }
    setAmenityInput("");
  };

  const removeAmenity = (item: string) => {
    setAmenities((a) => a.filter((x) => x !== item));
  };

  const handleSubmit = async () => {
    if (!name.trim()) { setError("이름은 필수입니다."); return; }
    if (!location.trim()) { setError("위치는 필수입니다."); return; }
    const cap = parseInt(capacity, 10);
    if (isNaN(cap) || cap < 1) { setError("수용인원은 1명 이상이어야 합니다."); return; }

    try {
      setBusy(true);
      setError(null);
      await onSubmit({
        name: name.trim(),
        location: location.trim(),
        floor: floor.trim() || undefined,
        capacity: cap,
        amenities: amenities.length > 0 ? amenities : undefined,
      });
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
          <h2 className="rsv-modal-title">{isEdit ? "공간 수정" : "공간 등록"}</h2>
          <button className="rsv-modal-close" onClick={onClose} aria-label="닫기">✕</button>
        </div>

        {error && <div className="rsv-error-banner">{error}</div>}

        <div className="rsv-form-group">
          <label>공간 이름 *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 회의실 A" autoFocus />
        </div>

        <div className="rsv-form-row">
          <div className="rsv-form-group">
            <label>위치 *</label>
            <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="예: 본관 3층" />
          </div>
          <div className="rsv-form-group">
            <label>층</label>
            <input type="text" value={floor} onChange={(e) => setFloor(e.target.value)} placeholder="예: 3F" />
          </div>
        </div>

        <div className="rsv-form-group">
          <label>수용인원 *</label>
          <input type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="10" />
        </div>

        <div className="rsv-form-group">
          <label>편의시설</label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input
              type="text"
              value={amenityInput}
              onChange={(e) => setAmenityInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAmenity(); } }}
              placeholder="프로젝터, 화이트보드..."
              style={{ flex: 1 }}
            />
            <button className="btn btn-ghost" type="button" onClick={addAmenity} style={{ flexShrink: 0 }}>추가</button>
          </div>
          {amenities.length > 0 && (
            <div className="rsv-amenity-list" style={{ marginTop: "0.5rem" }}>
              {amenities.map((a) => (
                <span key={a} className="rsv-amenity-badge" style={{ cursor: "pointer" }} onClick={() => removeAmenity(a)}>
                  {a} ✕
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="rsv-modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>취소</button>
          <button className="btn btn-primary" onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? "저장 중..." : isEdit ? "수정" : "등록"}
          </button>
        </div>
      </div>
    </div>
  );
}
