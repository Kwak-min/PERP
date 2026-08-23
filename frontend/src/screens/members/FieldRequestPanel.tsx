import { useState } from "react";

import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { SectionCard } from "../../components/ui/SectionCard";
import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { FIELD_LABELS, type MemberFieldRequest } from "./model";

type Props = Readonly<{
  memberId: string;
  apiSession: ApiSession;
  requests: readonly MemberFieldRequest[];
  isSelf: boolean;
  canManage: boolean;
  onChanged: () => void;
}>;

const STATUS_LABELS: Readonly<Record<string, string>> = { pending: "대기", approved: "승인", rejected: "반려" };
const STATUS_TONE: Readonly<Record<string, "success" | "warning" | "danger" | "neutral">> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
};

/** 본인 수정 승인: 본인이 개인정보성 필드 변경을 신청하고, 인사(member.write)가 승인/반려한다. 결재함을 거치지 않고 이 화면에서 완결된다. */
export function FieldRequestPanel({ memberId, apiSession, requests, isSelf, canManage, onChanged }: Props) {
  const [field, setField] = useState<keyof typeof FIELD_LABELS>("phone");
  const [newValue, setNewValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = requests.filter((request) => request.status === "pending");

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!newValue.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/members/${memberId}/field-requests`, {
        method: "POST",
        session: apiSession,
        body: { field, new_value: newValue },
      });
      setNewValue("");
      onChanged();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function decide(requestId: string, decision: "approve" | "reject"): Promise<void> {
    setDecidingId(requestId);
    setError(null);
    try {
      await apiRequest(`/members/field-requests/${requestId}/decide`, {
        method: "POST",
        session: apiSession,
        body: { decision },
      });
      onChanged();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setDecidingId(null);
    }
  }

  if (!isSelf && !canManage) return null;

  return (
    <SectionCard title="수정 신청" subtitle="개인정보성 필드는 신청 후 인사 승인을 거쳐 반영됩니다">
      {error && <div className="form-error" role="alert">{error}</div>}

      {isSelf && (
        <>
          <form className="leave-form" onSubmit={(event) => void submit(event)}>
            <div className="leave-form__fields">
              <label>
                필드
                <select value={field} onChange={(event) => setField(event.target.value as keyof typeof FIELD_LABELS)}>
                  {Object.entries(FIELD_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label>
                새 값
                <input type="text" value={newValue} onChange={(event) => setNewValue(event.target.value)} required />
              </label>
            </div>
            <div className="leave-form__actions">
              <Button type="submit" disabled={busy || !newValue.trim()}>수정 신청</Button>
            </div>
          </form>

          {requests.length > 0 && (
            <ul className="simple-list">
              {requests.map((request) => (
                <li key={request.id}>
                  <span>{FIELD_LABELS[request.field] ?? request.field} → {request.new_value}</span>
                  <Badge tone={STATUS_TONE[request.status] ?? "neutral"}>{STATUS_LABELS[request.status] ?? request.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {canManage && pending.length > 0 && (
        <>
          <p className="simple-list__subheading">대기 중인 신청</p>
          <ul className="simple-list">
            {pending.map((request) => (
              <li key={request.id}>
                <span>{FIELD_LABELS[request.field] ?? request.field}: {request.old_value ?? "—"} → {request.new_value}</span>
                <div className="leave-list__actions">
                  <Button size="small" disabled={decidingId === request.id} onClick={() => void decide(request.id, "approve")}>
                    승인
                  </Button>
                  <Button tone="danger" size="small" disabled={decidingId === request.id} onClick={() => void decide(request.id, "reject")}>
                    반려
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </SectionCard>
  );
}
