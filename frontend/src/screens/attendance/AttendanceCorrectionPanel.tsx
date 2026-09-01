import { useCallback, useEffect, useState } from "react";

import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { SectionCard } from "../../components/ui/SectionCard";
import type { OrgMember } from "../../hooks/useMembers";
import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { KIND_LABELS, attendanceCorrectionListSchema, type AttendanceCorrection } from "./model";
import { digitsOnly, toNonNegativeInt } from "../../utils/numberInput";

const STATUS_LABELS: Readonly<Record<string, string>> = { pending: "대기", approved: "승인", rejected: "반려" };
const STATUS_TONE: Readonly<Record<string, "success" | "warning" | "danger" | "neutral">> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
};
const CORRECTABLE_KINDS = ["present", "late", "absent", "remote"] as const;

type Props = Readonly<{
  apiSession: ApiSession;
  mode: "mine" | "manage";
  members?: readonly OrgMember[];
  reloadKey?: number;
  onChanged?: () => void;
}>;

/** 근태 수정요청. HR-001의 본인수정 승인과 같은 패턴 — 본인 신청, attendance.write가 승인/반려. */
export function AttendanceCorrectionPanel({ apiSession, mode, members = [], reloadKey = 0, onChanged }: Props) {
  const [items, setItems] = useState<readonly AttendanceCorrection[]>([]);
  const [onDate, setOnDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [kind, setKind] = useState<(typeof CORRECTABLE_KINDS)[number]>("present");
  const [hours, setHours] = useState("8");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const memberName = (memberId: string) => members.find((member) => member.user_id === memberId)?.name ?? "구성원";

  const reload = useCallback(async (): Promise<void> => {
    try {
      const path = mode === "manage" ? "/hr/attendance/corrections/pending" : "/hr/attendance/corrections";
      const result = attendanceCorrectionListSchema.parse(await apiRequest(path, { session: apiSession }));
      setItems(result.items);
    } catch (caught) {
      setError(userMessageOf(caught));
    }
  }, [apiSession, mode]);

  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/hr/attendance/corrections", {
        method: "POST",
        session: apiSession,
        body: { on_date: onDate, kind, hours: toNonNegativeInt(hours, 24), note },
      });
      setNote("");
      await reload();
      onChanged?.();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, decision: "approve" | "reject"): Promise<void> {
    setDecidingId(id);
    setError(null);
    try {
      await apiRequest(`/hr/attendance/corrections/${id}/decide`, {
        method: "POST",
        session: apiSession,
        body: { decision },
      });
      await reload();
      onChanged?.();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setDecidingId(null);
    }
  }

  return (
    <SectionCard
      padded
      title="근태 수정요청"
      subtitle={mode === "manage" ? "대기 중인 수정요청을 승인/반려합니다" : "출근을 놓쳤거나 시간이 잘못 기록됐을 때 신청합니다"}
    >
      {error && <div className="form-error" role="alert">{error}</div>}

      {mode === "mine" && (
        <form className="leave-form attendance-correction-form" onSubmit={(event) => void submit(event)}>
          <div className="leave-form__fields">
            <label>
              날짜
              <input type="date" value={onDate} onChange={(event) => setOnDate(event.target.value)} required />
            </label>
            <label>
              종류
              <select value={kind} onChange={(event) => setKind(event.target.value as (typeof CORRECTABLE_KINDS)[number])}>
                {CORRECTABLE_KINDS.map((value) => (
                  <option key={value} value={value}>{KIND_LABELS[value] ?? value}</option>
                ))}
              </select>
            </label>
            <label>
              근무시간
              <input
                type="text"
                inputMode="numeric"
                value={hours}
                onChange={(event) => setHours(digitsOnly(event.target.value))}
                onBlur={() => { if (hours === "") setHours("0"); }}
              />
            </label>
          </div>
          <label>
            사유
            <input type="text" value={note} onChange={(event) => setNote(event.target.value)} placeholder="예: 출근 체크를 깜빡했습니다" />
          </label>
          <div className="leave-form__actions">
            <Button type="submit" disabled={busy}>{busy ? "신청 중…" : "수정 신청"}</Button>
          </div>
        </form>
      )}

      {items.length === 0 ? (
        <p className="attendance-empty">{mode === "manage" ? "대기 중인 수정요청이 없습니다." : "신청한 수정요청이 없습니다."}</p>
      ) : (
        <ul className="simple-list">
          {items.map((item) => (
            <li key={item.id}>
              <span>
                {mode === "manage" && <><strong>{memberName(item.member_id)}</strong> · </>}
                {item.on_date} · {KIND_LABELS[item.kind] ?? item.kind} · {item.hours}시간
                {item.note && <> — {item.note}</>}
              </span>
              {mode === "manage" && item.status === "pending" ? (
                <div className="leave-list__actions">
                  <Button size="small" disabled={decidingId === item.id} onClick={() => void decide(item.id, "approve")}>승인</Button>
                  <Button tone="danger" size="small" disabled={decidingId === item.id} onClick={() => void decide(item.id, "reject")}>반려</Button>
                </div>
              ) : (
                <Badge tone={STATUS_TONE[item.status] ?? "neutral"}>{STATUS_LABELS[item.status] ?? item.status}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
