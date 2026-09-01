import { useState } from "react";

import { Button } from "../../components/ui/Button";
import { SectionCard } from "../../components/ui/SectionCard";
import type { LeavePolicy } from "../../hooks/useLeavePolicies";
import type { OrgMember } from "../../hooks/useMembers";
import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { LEAVE_KIND_LABELS } from "../attendance/model";
import { digitsOnly, toNonNegativeInt } from "../../utils/numberInput";

type Props = Readonly<{
  members: readonly OrgMember[];
  policies: readonly LeavePolicy[];
  apiSession: ApiSession;
  onGranted: () => void;
}>;

type GrantResult = Readonly<{ granted_days: number; used_days: number; remaining_days: number }>;

/** 관리자가 구성원에게 종류별 잔여 휴가일수를 부여한다. 백엔드 POST /hr/leave-balances는 기존에 있던 API. */
export function LeaveGrantPanel({ members, policies, apiSession, onGranted }: Props) {
  const [memberId, setMemberId] = useState("");
  const [kind, setKind] = useState("annual");
  const [days, setDays] = useState<string>(() => String(policies.find((p) => p.kind === "annual")?.default_days ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GrantResult | null>(null);

  function onKindChange(nextKind: string): void {
    setKind(nextKind);
    const policyDefault = policies.find((p) => p.kind === nextKind)?.default_days;
    if (policyDefault !== undefined) setDays(String(policyDefault));
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!memberId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const granted = (await apiRequest("/hr/leave-balances", {
        method: "POST",
        session: apiSession,
        body: { member_id: memberId, kind, granted_days: toNonNegativeInt(days) },
      })) as GrantResult;
      setResult(granted);
      onGranted();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard padded title="휴가 부여" subtitle="구성원별 잔여 휴가일수를 확정합니다">
      {error && <div className="form-error" role="alert">{error}</div>}
      <form className="leave-form" onSubmit={(event) => void submit(event)}>
        <div className="leave-form__fields">
          <label>
            구성원
            <select value={memberId} onChange={(event) => setMemberId(event.target.value)} required>
              <option value="">선택하세요</option>
              {members.map((member) => (
                <option key={member.user_id} value={member.user_id}>{member.name}</option>
              ))}
            </select>
          </label>
          <label>
            종류
            <select value={kind} onChange={(event) => onKindChange(event.target.value)}>
              {Object.entries(LEAVE_KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            부여일수
            <input
              type="text"
              inputMode="numeric"
              value={days}
              onChange={(event) => setDays(digitsOnly(event.target.value))}
              onBlur={() => { if (days === "") setDays("0"); }}
              required
            />
          </label>
        </div>
        <div className="leave-form__actions">
          <Button type="submit" disabled={busy || !memberId}>
            {busy ? "부여 중…" : "부여"}
          </Button>
        </div>
      </form>
      {result && (
        <p className="policy-grant-result">
          부여 {result.granted_days}일 · 사용 {result.used_days}일 · 잔여 {result.remaining_days}일로 반영됐습니다.
        </p>
      )}
    </SectionCard>
  );
}
