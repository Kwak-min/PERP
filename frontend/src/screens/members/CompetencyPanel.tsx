import { useState } from "react";

import { Button } from "../../components/ui/Button";
import { SectionCard } from "../../components/ui/SectionCard";
import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { LEVEL_LABELS, type MemberCompetency } from "./model";

type Props = Readonly<{
  memberId: string;
  apiSession: ApiSession;
  competencies: readonly MemberCompetency[];
  isSelf: boolean;
  canManage: boolean;
  onChanged: () => void;
}>;

const LEVELS = ["beginner", "intermediate", "advanced"] as const;

/** 본인이 직접 등록하는 역량(스킬) 목록. 승인 없이 즉시 반영된다(자기 신고 데이터라 저위험). */
export function CompetencyPanel({ memberId, apiSession, competencies, isSelf, canManage, onChanged }: Props) {
  const [label, setLabel] = useState("");
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("intermediate");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canEdit = isSelf || canManage;

  async function add(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/members/${memberId}/competencies`, {
        method: "POST",
        session: apiSession,
        body: { label, level, note },
      });
      setLabel("");
      setNote("");
      onChanged();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(competencyId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/members/competencies/${competencyId}`, { method: "DELETE", session: apiSession });
      onChanged();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard title="역량" subtitle="본인이 직접 등록하는 스킬 목록">
      {error && <div className="form-error" role="alert">{error}</div>}
      {competencies.length === 0 ? (
        <p className="attendance-empty">등록된 역량이 없습니다.</p>
      ) : (
        <ul className="member-profile-list">
          {competencies.map((competency) => (
            <li key={competency.id}>
              <span>
                <strong>{competency.label}</strong> · {LEVEL_LABELS[competency.level] ?? competency.level}
                {competency.note && <> — {competency.note}</>}
              </span>
              {canEdit && (
                <Button tone="danger" size="small" disabled={busy} onClick={() => void remove(competency.id)}>
                  삭제
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <form className="leave-form" onSubmit={(event) => void add(event)}>
          <div className="leave-form__fields">
            <label>
              스킬
              <input type="text" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="예: React" required />
            </label>
            <label>
              수준
              <select value={level} onChange={(event) => setLevel(event.target.value as (typeof LEVELS)[number])}>
                {LEVELS.map((value) => (
                  <option key={value} value={value}>{LEVEL_LABELS[value]}</option>
                ))}
              </select>
            </label>
            <label>
              메모 (선택)
              <input type="text" value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
          </div>
          <div className="leave-form__actions">
            <Button type="submit" disabled={busy || !label.trim()}>추가</Button>
          </div>
        </form>
      )}
    </SectionCard>
  );
}
