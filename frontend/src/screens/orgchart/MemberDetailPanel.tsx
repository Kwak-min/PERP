import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { z } from "zod";
import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { isPgWorkspace } from "../../services/workspace";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import {
  demotedTitle,
  promotedTitle,
  type OrgMember,
} from "./model";

type Props = Readonly<{
  member: OrgMember;
  departmentName: string;
  busy: boolean;
  canAssign: boolean;
  session: ApiSession;
  onChangeTitle: (member: OrgMember, title: string) => void;
}>;

export function MemberDetailPanel({ member, departmentName, busy, canAssign, session, onChangeTitle }: Props) {
  const next = promotedTitle(member.title);
  const previous = demotedTitle(member.title);

  return (
    <section className="member-detail" aria-label={`${member.name} 상세`}>
      <header className="member-detail__head">
        <span className="member-detail__avatar" aria-hidden="true">{member.name.slice(0, 1)}</span>
        <div>
          <h2>{member.name}</h2>
          <p>{member.title ?? "직책 미지정"} · {departmentName}</p>
        </div>
      </header>

      <dl className="member-detail__facts">
        <div>
          <dt>이메일</dt>
          <dd>{member.email}</dd>
        </div>
        <div>
          <dt>부서</dt>
          <dd>{departmentName}</dd>
        </div>
        <div>
          <dt>전화번호</dt>
          <dd>{member.phone ?? "—"}</dd>
        </div>
        <div>
          <dt>직책</dt>
          <dd>{member.title ?? "—"}</dd>
        </div>
        <div>
          <dt>역할</dt>
          <dd>{member.roles.join(", ") || "구성원"}</dd>
        </div>
        <div>
          <dt>상태</dt>
          <dd>
            <Badge tone={member.status === "active" ? "success" : "neutral"}>{member.status}</Badge>
          </dd>
        </div>
      </dl>

      <Link className="button button--neutral button--small" to={`/hr/members/${encodeURIComponent(member.user_id)}`}>인사 프로필 자세히 보기</Link>

      {canAssign && (isPgWorkspace(session.orgId) ? <PgTitlePicker key={`${member.membership_id}:${member.title}`} session={session} member={member} busy={busy} onChangeTitle={onChangeTitle} /> : <div className="member-detail__ladder">
        <h3>직책 조정</h3>
        <p>승급은 한 단계 위, 하락은 한 단계 아래 직책으로 바꿉니다.</p>
        <div className="member-detail__ladder-actions">
          <Button
            size="small"
            disabled={busy || next === null}
            onClick={() => next && onChangeTitle(member, next)}
          >
            승급{next ? ` → ${next}` : " (최상위)"}
          </Button>
          <Button
            tone="neutral"
            size="small"
            disabled={busy || previous === null}
            onClick={() => previous && onChangeTitle(member, previous)}
          >
            하락{previous ? ` → ${previous}` : " (최하위)"}
          </Button>
        </div>
      </div>)}
    </section>
  );
}

const positionsSchema = z.object({ items: z.array(z.object({ value: z.string(), label: z.string() })) });
function PgTitlePicker({ session, member, busy, onChangeTitle }: Pick<Props, "session" | "member" | "busy" | "onChangeTitle">) {
  const [positions, setPositions] = useState<readonly string[] | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    apiRequest("/pg/positions/options", { session, signal: controller.signal }).then(payload => {
      const items = positionsSchema.parse(payload).items;
      if (!controller.signal.aborted) setPositions(items.map(item => item.label));
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [session]);
  return <div className="member-detail__ladder"><h3>직책 조정</h3>
    {error ? <p className="form-error" role="alert">{error}</p> : positions === null ? <p role="status">등록된 직책을 불러오는 중입니다…</p>
      : positions.length === 0 ? <p>조직에 등록된 직책이 없습니다.</p> : <>
        <label>등록된 직책<select value={title} onChange={event => setTitle(event.target.value)}><option value="">직책 선택</option>{positions.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <Button size="small" disabled={busy || !title || title === member.title} onClick={() => onChangeTitle(member, title)}>직책 변경</Button>
      </>}
  </div>;
}
