import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/Button";
import { SectionCard } from "../../components/ui/SectionCard";
import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import {
  STAGES,
  STAGE_LABELS,
  applicationListSchema,
  postingListSchema,
  sixMonthsFromToday,
  type Application,
  type Posting,
} from "./model";
import { digitsOnly, toNonNegativeInt } from "../../utils/numberInput";

type Props = Readonly<{ apiSession: ApiSession }>;

const ALL_POSTINGS = "__all__";

function nextStageOf(stage: string): string | null {
  const index = STAGES.indexOf(stage as (typeof STAGES)[number]);
  if (index < 0 || index >= STAGES.length - 2) return null;
  return STAGES[index + 1] ?? null;
}

/** 공고 등록·마감, 지원자 등록, 6단계 칸반(단계 이동·평가·계정초대)을 관리한다. */
export function PipelinePanel({ apiSession }: Props) {
  const [postings, setPostings] = useState<readonly Posting[]>([]);
  const [applications, setApplications] = useState<readonly Application[]>([]);
  const [selectedPostingId, setSelectedPostingId] = useState<string>(ALL_POSTINGS);
  const [postingTitle, setPostingTitle] = useState("");
  const [applicantName, setApplicantName] = useState("");
  const [applicantEmail, setApplicantEmail] = useState("");
  const [applicantRetainUntil, setApplicantRetainUntil] = useState(sixMonthsFromToday());
  const [busy, setBusy] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scoreDrafts, setScoreDrafts] = useState<Record<string, string>>({});

  const reload = useCallback(async (): Promise<void> => {
    try {
      const postingResult = postingListSchema.parse(
        await apiRequest("/hr/postings", { session: apiSession }),
      );
      setPostings(postingResult.items);

      const applicationPath =
        selectedPostingId === ALL_POSTINGS
          ? "/hr/applications"
          : `/hr/postings/${selectedPostingId}/applications`;
      const applicationResult = applicationListSchema.parse(
        await apiRequest(applicationPath, { session: apiSession }),
      );
      setApplications(applicationResult.items);
    } catch (caught) {
      setError(userMessageOf(caught));
    }
  }, [apiSession, selectedPostingId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function createPosting(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!postingTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/hr/postings", {
        method: "POST",
        session: apiSession,
        body: { title: postingTitle },
      });
      setPostingTitle("");
      setNotice("공고를 등록했습니다.");
      await reload();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function closePosting(postingId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/hr/postings/${postingId}/close`, { method: "POST", session: apiSession });
      setNotice("공고를 마감했습니다.");
      await reload();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function registerApplicant(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (selectedPostingId === ALL_POSTINGS || !applicantName.trim() || !applicantEmail.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/hr/postings/${selectedPostingId}/applications`, {
        method: "POST",
        session: apiSession,
        body: {
          applicant_name: applicantName,
          applicant_email: applicantEmail,
          retain_until: applicantRetainUntil,
        },
      });
      setApplicantName("");
      setApplicantEmail("");
      setNotice("지원자를 등록했습니다.");
      await reload();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function moveStage(application: Application, stage: string): Promise<void> {
    setMovingId(application.id);
    setError(null);
    try {
      await apiRequest(`/hr/applications/${application.id}/stage`, {
        method: "POST",
        session: apiSession,
        body: { stage, ...(application.score === null ? {} : { score: application.score }) },
      });
      await reload();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setMovingId(null);
    }
  }

  async function setScore(application: Application, score: number): Promise<void> {
    setMovingId(application.id);
    setError(null);
    try {
      await apiRequest(`/hr/applications/${application.id}/stage`, {
        method: "POST",
        session: apiSession,
        body: { stage: application.stage, score },
      });
      await reload();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setMovingId(null);
    }
  }

  function scoreValue(application: Application): string {
    const draft = scoreDrafts[application.id];
    if (draft !== undefined) return draft;
    return application.score === null ? "0" : String(application.score);
  }

  function commitScore(application: Application): void {
    const draft = scoreDrafts[application.id];
    if (draft === undefined) return;
    const value = toNonNegativeInt(draft, 100);
    setScoreDrafts((prev) => {
      const next = { ...prev };
      delete next[application.id];
      return next;
    });
    if (value !== (application.score ?? 0)) void setScore(application, value);
  }

  async function inviteApplicant(application: Application): Promise<void> {
    setMovingId(application.id);
    setError(null);
    try {
      await apiRequest("/members/invites", {
        method: "POST",
        session: apiSession,
        body: { email: application.applicant_email },
      });
      setNotice(`${application.applicant_name}님에게 계정 초대를 보냈습니다.`);
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setMovingId(null);
    }
  }

  return (
    <div className="recruitment-pipeline">
      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && (
        <div className="screen-notice" role="status">
          <span>{notice}</span>
          <Button tone="ghost" size="small" onClick={() => setNotice(null)}>닫기</Button>
        </div>
      )}

      <SectionCard padded title="채용 공고" subtitle="공고를 등록하고 지원자를 확인할 공고를 선택합니다">
        <form className="leave-form" onSubmit={(event) => void createPosting(event)}>
          <div className="leave-form__fields">
            <label>
              공고 제목
              <input
                type="text"
                value={postingTitle}
                onChange={(event) => setPostingTitle(event.target.value)}
                placeholder="예: 프런트엔드 개발자"
                required
              />
            </label>
          </div>
          <div className="leave-form__actions">
            <Button type="submit" disabled={busy || !postingTitle.trim()}>등록</Button>
          </div>
        </form>

        <div className="posting-list">
          <label>
            조회할 공고
            <select value={selectedPostingId} onChange={(event) => setSelectedPostingId(event.target.value)}>
              <option value={ALL_POSTINGS}>전체 공고</option>
              {postings.map((posting) => (
                <option key={posting.id} value={posting.id}>
                  {posting.title} {posting.status === "closed" ? "(마감)" : ""}
                </option>
              ))}
            </select>
          </label>
          {selectedPostingId !== ALL_POSTINGS &&
            postings.find((posting) => posting.id === selectedPostingId)?.status === "open" && (
              <Button tone="neutral" size="small" disabled={busy} onClick={() => void closePosting(selectedPostingId)}>
                이 공고 마감
              </Button>
            )}
        </div>
      </SectionCard>

      {selectedPostingId !== ALL_POSTINGS && (
        <SectionCard padded title="지원자 등록" subtitle="선택한 공고에 지원자를 등록합니다">
          <form className="leave-form" onSubmit={(event) => void registerApplicant(event)}>
            <div className="leave-form__fields">
              <label>
                이름
                <input type="text" value={applicantName} onChange={(event) => setApplicantName(event.target.value)} required />
              </label>
              <label>
                이메일
                <input type="email" value={applicantEmail} onChange={(event) => setApplicantEmail(event.target.value)} required />
              </label>
              <label>
                개인정보 보존기한
                <input
                  type="date"
                  value={applicantRetainUntil}
                  onChange={(event) => setApplicantRetainUntil(event.target.value)}
                />
              </label>
            </div>
            <div className="leave-form__actions">
              <Button type="submit" disabled={busy || !applicantName.trim() || !applicantEmail.trim()}>등록</Button>
            </div>
          </form>
        </SectionCard>
      )}

      <SectionCard title="채용 파이프라인" subtitle="단계별 지원자 현황">
        <div className="kanban">
          {STAGES.map((stage) => {
            const cards = applications.filter((application) => application.stage === stage);
            return (
              <section className="kanban__col" key={stage}>
                <header className="kanban__head">
                  <span className="kanban__title">{STAGE_LABELS[stage]}</span>
                  <span className="kanban__count">{cards.length}</span>
                </header>
                <div className="kanban__body">
                  {cards.map((application) => {
                    const next = nextStageOf(application.stage);
                    const busyCard = movingId === application.id;
                    return (
                      <article className="kanban__card recruitment-card" key={application.id}>
                        <p className="kanban__card-title">{application.applicant_name}</p>
                        <div className="kanban__card-meta">
                          <span>{application.applicant_email}</span>
                        </div>
                        <label className="recruitment-card__score">
                          평가 점수
                          <input
                            type="text"
                            inputMode="numeric"
                            value={scoreValue(application)}
                            disabled={busyCard}
                            onChange={(event) =>
                              setScoreDrafts((prev) => ({ ...prev, [application.id]: digitsOnly(event.target.value) }))
                            }
                            onBlur={() => commitScore(application)}
                          />
                        </label>
                        <div className="recruitment-card__actions">
                          {next && (
                            <Button size="small" disabled={busyCard} onClick={() => void moveStage(application, next)}>
                              {STAGE_LABELS[next]}(으)로
                            </Button>
                          )}
                          {stage !== "rejected" && stage !== "hired" && (
                            <Button
                              tone="danger"
                              size="small"
                              disabled={busyCard}
                              onClick={() => void moveStage(application, "rejected")}
                            >
                              불합격
                            </Button>
                          )}
                          {stage === "hired" && (
                            <Button size="small" disabled={busyCard} onClick={() => void inviteApplicant(application)}>
                              계정 초대
                            </Button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                  {cards.length === 0 && <p className="kanban__empty">항목 없음</p>}
                </div>
              </section>
            );
          })}
        </div>
      </SectionCard>
    </div>
  );
}
