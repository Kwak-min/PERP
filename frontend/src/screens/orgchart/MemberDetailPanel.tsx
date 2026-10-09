import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import {
  PERMISSION_LABELS,
  demotedTitle,
  permissionsOf,
  promotedTitle,
  type OrgMember,
} from "./model";

type Props = Readonly<{
  member: OrgMember;
  departmentName: string;
  busy: boolean;
  onChangeTitle: (member: OrgMember, title: string) => void;
}>;

export function MemberDetailPanel({ member, departmentName, busy, onChangeTitle }: Props) {
  const next = promotedTitle(member.title);
  const previous = demotedTitle(member.title);
  const permissions = PERMISSION_LABELS.filter(({ key }) =>
    permissionsOf(member.roles).includes(key),
  );

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

      <div className="member-detail__permissions" aria-label="권한">
        {permissions.map(({ key, label }) => (
          <span key={key} className={`orgchart__permission orgchart__permission--${key}`}>
            {label}
          </span>
        ))}
      </div>

      <div className="member-detail__ladder">
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
      </div>
    </section>
  );
}
