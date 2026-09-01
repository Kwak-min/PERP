import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/Button";
import { SectionCard } from "../../components/ui/SectionCard";
import type { OrgMember } from "../../hooks/useMembers";
import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { onboardingListSchema, type OnboardingItem } from "./model";

type Props = Readonly<{ apiSession: ApiSession; members: readonly OrgMember[] }>;

/** 합격자 온보딩(또는 퇴사자 오프보딩) 체크리스트를 생성하고 진행률을 관리한다. */
export function OnboardingPanel({ apiSession, members }: Props) {
  const [memberId, setMemberId] = useState("");
  const [flow, setFlow] = useState<"onboarding" | "offboarding">("onboarding");
  const [labelsText, setLabelsText] = useState("");
  const [items, setItems] = useState<readonly OnboardingItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (!memberId) {
      setItems([]);
      return;
    }
    try {
      const result = onboardingListSchema.parse(
        await apiRequest(`/hr/onboarding?member_id=${memberId}`, { session: apiSession }),
      );
      setItems(result.items);
    } catch (caught) {
      setError(userMessageOf(caught));
    }
  }, [apiSession, memberId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function createChecklist(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const labels = labelsText
      .split("\n")
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
    if (!memberId || labels.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/hr/onboarding", {
        method: "POST",
        session: apiSession,
        body: { member_id: memberId, flow, labels },
      });
      setLabelsText("");
      setNotice("체크리스트를 생성했습니다.");
      await reload();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function completeItem(itemId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/hr/onboarding/${itemId}/complete`, { method: "POST", session: apiSession });
      await reload();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  const done = items.filter((item) => item.done).length;

  return (
    <div className="recruitment-onboarding">
      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && (
        <div className="screen-notice" role="status">
          <span>{notice}</span>
          <Button tone="ghost" size="small" onClick={() => setNotice(null)}>닫기</Button>
        </div>
      )}

      <SectionCard padded title="온보딩·오프보딩 체크리스트" subtitle="구성원을 선택하고 체크리스트 항목을 추가합니다">
        <form className="leave-form" onSubmit={(event) => void createChecklist(event)}>
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
              구분
              <select value={flow} onChange={(event) => setFlow(event.target.value as "onboarding" | "offboarding")}>
                <option value="onboarding">온보딩</option>
                <option value="offboarding">오프보딩</option>
              </select>
            </label>
          </div>
          <label>
            체크리스트 항목 (한 줄에 하나씩)
            <textarea
              rows={3}
              value={labelsText}
              onChange={(event) => setLabelsText(event.target.value)}
              placeholder={"계정 발급\n장비 수령\n사내 규정 안내"}
            />
          </label>
          <div className="leave-form__actions">
            <Button type="submit" disabled={busy || !memberId || labelsText.trim().length === 0}>추가</Button>
          </div>
        </form>
      </SectionCard>

      {memberId && (
        <SectionCard
          title="진행 현황"
          subtitle={`${members.find((member) => member.user_id === memberId)?.name ?? "구성원"}의 체크리스트`}
          foot={`${done} / ${items.length} 완료`}
        >
          {items.length === 0 ? (
            <p className="attendance-empty">등록된 체크리스트가 없습니다.</p>
          ) : (
            <ul className="onboarding-list">
              {items.map((item) => (
                <li key={item.id}>
                  <span>{item.label}</span>
                  {item.done ? (
                    <span className="onboarding-list__done">완료</span>
                  ) : (
                    <Button size="small" disabled={busy} onClick={() => void completeItem(item.id)}>
                      완료 처리
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
    </div>
  );
}
