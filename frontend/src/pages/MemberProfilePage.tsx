import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import { ApiError, apiRequest, userMessageOf } from "../services/api";
import { useSession } from "../store/session";
import {
  ASSIGNMENT_ACTION,
  memberActivitySchema,
  memberAssetListSchema,
  memberCompetencyListSchema,
  memberDocumentListSchema,
  memberFieldRequestListSchema,
  memberProfileSchema,
  type MemberActivityItem,
  type MemberAsset,
  type MemberCompetency,
  type MemberDocument,
  type MemberFieldRequest,
  type MemberProfile,
} from "../screens/members/model";
import { CompetencyPanel } from "../screens/members/CompetencyPanel";
import { FieldRequestPanel } from "../screens/members/FieldRequestPanel";

import "../screens/attendance.css";
import "./MemberProfilePage.css";

type Tab = "profile" | "history" | "activity" | "documents" | "assets" | "competencies";

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: "profile", label: "프로필" },
  { key: "history", label: "소속·직책 이력" },
  { key: "activity", label: "활동" },
  { key: "competencies", label: "역량" },
  { key: "documents", label: "문서" },
  { key: "assets", label: "장비" },
];

function formatDate(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ko-KR");
}

export function MemberProfilePage() {
  const { memberId } = useParams<{ memberId: string }>();
  const navigate = useNavigate();
  const session = useSession();
  const [tab, setTab] = useState<Tab>("profile");
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [activity, setActivity] = useState<readonly MemberActivityItem[]>([]);
  const [documents, setDocuments] = useState<readonly MemberDocument[]>([]);
  const [assets, setAssets] = useState<readonly MemberAsset[]>([]);
  const [competencies, setCompetencies] = useState<readonly MemberCompetency[]>([]);
  const [fieldRequests, setFieldRequests] = useState<readonly MemberFieldRequest[]>([]);
  const [hasMemberWrite, setHasMemberWrite] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const apiSession = useMemo(
    () => (session?.orgId ? { token: session.token, orgId: session.orgId } : null),
    [session?.token, session?.orgId],
  );

  const reload = useCallback(async (): Promise<void> => {
    if (!apiSession || !memberId) return;
    setLoading(true);
    setNotFound(false);
    const results = await Promise.allSettled([
      apiRequest(`/members/${memberId}/profile`, { session: apiSession }),
      apiRequest(`/members/activity?member_id=${memberId}`, { session: apiSession }),
      apiRequest(`/documents?owner_id=${memberId}`, { session: apiSession }),
      apiRequest(`/assets?custodian_id=${memberId}`, { session: apiSession }),
      apiRequest(`/members/${memberId}/competencies`, { session: apiSession }),
      apiRequest(`/members/${memberId}/field-requests`, { session: apiSession }),
    ]);
    const [profileResult, activityResult, documentsResult, assetsResult, competenciesResult, fieldRequestsResult] =
      results;
    const nextErrors: Record<string, string> = {};

    if (profileResult.status === "fulfilled") {
      setProfile(memberProfileSchema.parse(profileResult.value));
    } else {
      setProfile(null);
      if (profileResult.reason instanceof ApiError && profileResult.reason.status === 404) setNotFound(true);
      else nextErrors.profile = userMessageOf(profileResult.reason);
    }

    if (activityResult.status === "fulfilled") {
      setActivity(memberActivitySchema.parse(activityResult.value).items);
    } else {
      setActivity([]);
      nextErrors.activity = userMessageOf(activityResult.reason);
    }

    if (documentsResult.status === "fulfilled") {
      setDocuments(memberDocumentListSchema.parse(documentsResult.value).items);
    } else {
      setDocuments([]);
      nextErrors.documents = userMessageOf(documentsResult.reason);
    }

    if (assetsResult.status === "fulfilled") {
      setAssets(memberAssetListSchema.parse(assetsResult.value).items);
    } else {
      setAssets([]);
      nextErrors.assets = userMessageOf(assetsResult.reason);
    }

    if (competenciesResult.status === "fulfilled") {
      setCompetencies(memberCompetencyListSchema.parse(competenciesResult.value).items);
    } else {
      setCompetencies([]);
    }

    // 이 요청은 본인이거나 member.write가 있어야 성공한다 — 성공 여부 자체가 "관리 가능" 판정 신호다.
    if (fieldRequestsResult.status === "fulfilled") {
      setFieldRequests(memberFieldRequestListSchema.parse(fieldRequestsResult.value).items);
      setHasMemberWrite(true);
    } else {
      setFieldRequests([]);
      setHasMemberWrite(false);
    }

    setErrors(nextErrors);
    setLoading(false);
  }, [apiSession, memberId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const assignmentHistory = activity.filter((item) => item.action === ASSIGNMENT_ACTION);
  const otherActivity = activity.filter((item) => item.action !== ASSIGNMENT_ACTION);
  const isSelf = Boolean(profile && session && profile.email === session.email);
  const canManageOthers = hasMemberWrite && !isSelf;

  if (notFound) {
    return (
      <div className="screen">
        <SectionCard title="구성원을 찾을 수 없습니다" subtitle="조직에서 삭제되었거나 잘못된 링크일 수 있습니다">
          <Button tone="neutral" onClick={() => navigate(-1)}>뒤로 가기</Button>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="screen" data-screen-id="HR-001">
      <header className="screen-header">
        <div>
          <div className="screen-header__meta">
            <span className="eyebrow">사람</span>
            <Badge>HR-001</Badge>
            <Badge>HR</Badge>
          </div>
          <h1>{profile?.name ?? (loading ? "불러오는 중…" : "구성원 프로필")}</h1>
          <p>{profile?.email ?? ""}</p>
        </div>
        <div className="screen-header__actions">
          <Button tone="neutral" size="small" onClick={() => navigate(-1)}>목록으로</Button>
          <Button tone="neutral" size="small" disabled={loading} onClick={() => void reload()}>새로 고침</Button>
        </div>
      </header>

      <div className="member-profile-tabs" role="tablist" aria-label="구성원 프로필 화면 전환">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-pressed={tab === item.key}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "profile" && (
        <SectionCard title="연락처 · 소속" subtitle="필드별 공개 범위에 따라 일부 값은 마스킹됩니다">
          {!profile ? (
            <p className="attendance-empty">불러오는 중입니다…</p>
          ) : (
            <dl className="member-profile-facts">
              <div><dt>이름</dt><dd>{profile.name}</dd></div>
              <div><dt>이메일</dt><dd>{profile.email}</dd></div>
              <div><dt>전화번호</dt><dd>{profile.phone ?? "—"}</dd></div>
              <div><dt>주소</dt><dd>{profile.address ?? "—"}</dd></div>
              <div><dt>생년월일</dt><dd>{profile.birth_date ?? "—"}</dd></div>
              <div><dt>비상연락처</dt><dd>{profile.emergency_contact ?? "—"}</dd></div>
              <div><dt>소속</dt><dd>{profile.department_id ?? "미지정"}</dd></div>
              <div><dt>직책</dt><dd>{profile.title ?? "미지정"}</dd></div>
              <div><dt>역할</dt><dd>{profile.roles.join(" · ") || "미지정"}</dd></div>
              <div><dt>상태</dt><dd>{profile.status}</dd></div>
              <div><dt>가입일</dt><dd>{formatDate(profile.joined_at)}</dd></div>
            </dl>
          )}
        </SectionCard>
      )}

      {tab === "profile" && apiSession && (isSelf || canManageOthers) && (
        <FieldRequestPanel
          memberId={memberId ?? ""}
          apiSession={apiSession}
          requests={fieldRequests}
          isSelf={isSelf}
          canManage={canManageOthers}
          onChanged={() => void reload()}
        />
      )}

      {tab === "history" && (
        <SectionCard title="소속·직책 이력" subtitle="감사 로그에서 재구성한 변경 이력">
          {errors.activity && <div className="form-error" role="alert">{errors.activity}</div>}
          {assignmentHistory.length === 0 ? (
            <p className="attendance-empty">소속·직책 변경 이력이 없습니다.</p>
          ) : (
            <div className="table-wrap" role="region" aria-label="소속·직책 이력" tabIndex={0}>
              <table>
                <thead>
                  <tr><th>시각</th><th>행위자</th><th>변경 내용</th></tr>
                </thead>
                <tbody>
                  {assignmentHistory.map((item) => (
                    <tr key={item.id}>
                      <td>{formatDate(item.created_at)}</td>
                      <td>{item.actor_name}</td>
                      <td>{item.action_label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      )}

      {tab === "activity" && (
        <SectionCard title="활동" subtitle="이 구성원과 관련된 그 외 조직 활동 로그">
          {errors.activity && <div className="form-error" role="alert">{errors.activity}</div>}
          {otherActivity.length === 0 ? (
            <p className="attendance-empty">표시할 활동이 없습니다.</p>
          ) : (
            <div className="table-wrap" role="region" aria-label="활동" tabIndex={0}>
              <table>
                <thead>
                  <tr><th>시각</th><th>행위자</th><th>내용</th><th>대상</th></tr>
                </thead>
                <tbody>
                  {otherActivity.map((item) => (
                    <tr key={item.id}>
                      <td>{formatDate(item.created_at)}</td>
                      <td>{item.actor_name}</td>
                      <td>{item.action_label}</td>
                      <td>{item.target ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      )}

      {tab === "competencies" && apiSession && (
        <CompetencyPanel
          memberId={memberId ?? ""}
          apiSession={apiSession}
          competencies={competencies}
          isSelf={isSelf}
          canManage={canManageOthers}
          onChanged={() => void reload()}
        />
      )}

      {tab === "documents" && (
        <SectionCard title="문서" subtitle="이 구성원이 소유한 문서">
          {errors.documents && <div className="form-error" role="alert">{errors.documents}</div>}
          {documents.length === 0 ? (
            <p className="attendance-empty">문서가 없습니다.</p>
          ) : (
            <ul className="simple-list">
              {documents.map((document) => (
                <li key={document.id}>
                  <span>{document.title}</span>
                  <Badge>{document.doc_type}</Badge>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "assets" && (
        <SectionCard title="장비" subtitle="이 구성원이 보유 중인 자산">
          {errors.assets && <div className="form-error" role="alert">{errors.assets}</div>}
          {assets.length === 0 ? (
            <p className="attendance-empty">보유 중인 장비가 없습니다.</p>
          ) : (
            <ul className="simple-list">
              {assets.map((asset) => (
                <li key={asset.id}>
                  <span>{asset.name} ({asset.asset_no})</span>
                  <Badge tone={asset.status === "available" ? "neutral" : "success"}>{asset.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
    </div>
  );
}
