import { useMemo, useState } from "react";

import { Button } from "../../components/ui/Button";
import { SectionCard } from "../../components/ui/SectionCard";
import type { LeavePolicy } from "../../hooks/useLeavePolicies";
import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { LEAVE_KIND_LABELS } from "../attendance/model";

type DraftPolicy = Readonly<{
  default_days: number;
  carryover_enabled: boolean;
  carryover_max_days: number;
  expiry_note: string;
}>;

const EMPTY_DRAFT: DraftPolicy = {
  default_days: 0,
  carryover_enabled: false,
  carryover_max_days: 0,
  expiry_note: "",
};

function draftsFrom(policies: readonly LeavePolicy[]): Record<string, DraftPolicy> {
  const out: Record<string, DraftPolicy> = {};
  for (const kind of Object.keys(LEAVE_KIND_LABELS)) {
    const found = policies.find((policy) => policy.kind === kind);
    out[kind] = found
      ? {
          default_days: found.default_days,
          carryover_enabled: found.carryover_enabled,
          carryover_max_days: found.carryover_max_days,
          expiry_note: found.expiry_note,
        }
      : EMPTY_DRAFT;
  }
  return out;
}

type Props = Readonly<{
  policies: readonly LeavePolicy[];
  apiSession: ApiSession;
  onSaved: () => void;
}>;

/** 휴가 종류별 기본 부여일수·이월 규칙을 설정한다. 이월·소멸은 저장만 하고 실제 집행은 하지 않는다. */
export function LeavePolicyPanel({ policies, apiSession, onSaved }: Props) {
  const [drafts, setDrafts] = useState<Record<string, DraftPolicy>>(() => draftsFrom(policies));
  const [savingKind, setSavingKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kinds = useMemo(() => Object.keys(LEAVE_KIND_LABELS), []);

  function patch(kind: string, next: Partial<DraftPolicy>): void {
    setDrafts((prev) => ({ ...prev, [kind]: { ...(prev[kind] ?? EMPTY_DRAFT), ...next } }));
  }

  async function save(kind: string): Promise<void> {
    const draft = drafts[kind] ?? EMPTY_DRAFT;
    setSavingKind(kind);
    setError(null);
    try {
      await apiRequest("/hr/leave-policies", {
        method: "POST",
        session: apiSession,
        body: { kind, ...draft },
      });
      onSaved();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setSavingKind(null);
    }
  }

  return (
    <SectionCard
      padded
      title="휴가 정책"
      subtitle="종류별 기본 부여일수와 이월 규칙"
      foot="이월·소멸은 값만 저장되며 자동 집행되지 않습니다. 실제 부여는 아래 '휴가 부여'에서 처리하세요."
    >
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="policy-list">
        {kinds.map((kind) => {
          const draft = drafts[kind] ?? EMPTY_DRAFT;
          return (
            <div className="policy-row" key={kind}>
              <div className="policy-row__title">{LEAVE_KIND_LABELS[kind] ?? kind}</div>
              <label>
                기본 부여일수
                <input
                  type="number"
                  min={0}
                  value={draft.default_days}
                  onChange={(event) => patch(kind, { default_days: Number(event.target.value) })}
                />
              </label>
              <label className="policy-row__checkbox">
                <input
                  type="checkbox"
                  checked={draft.carryover_enabled}
                  onChange={(event) => patch(kind, { carryover_enabled: event.target.checked })}
                />
                이월 허용
              </label>
              <label>
                이월 한도
                <input
                  type="number"
                  min={0}
                  disabled={!draft.carryover_enabled}
                  value={draft.carryover_max_days}
                  onChange={(event) => patch(kind, { carryover_max_days: Number(event.target.value) })}
                />
              </label>
              <label className="policy-row__note">
                소멸 메모
                <input
                  type="text"
                  placeholder="예: 매년 12월 31일 소멸"
                  value={draft.expiry_note}
                  onChange={(event) => patch(kind, { expiry_note: event.target.value })}
                />
              </label>
              <Button size="small" disabled={savingKind === kind} onClick={() => void save(kind)}>
                {savingKind === kind ? "저장 중…" : "저장"}
              </Button>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}
