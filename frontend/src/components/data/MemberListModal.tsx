import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { apiRequest, userMessageOf, type ApiSession } from "../../services/api";
import { useModalFocus } from "../../hooks/useModalFocus";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";

export const memberSchema = z.object({
  membership_id: z.string(),
  email: z.string(),
  name: z.string(),
  roles: z.array(z.string()).catch([]),
  status: z.string(),
  department_id: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
});

export const membersSchema = z.object({ items: z.array(memberSchema) });
export type Member = z.infer<typeof memberSchema>;

type Props = Readonly<{
  session: ApiSession | null;
  fallback: readonly (readonly string[])[];
  onClose: () => void;
}>;

function fallbackMembers(rows: readonly (readonly string[])[]): readonly Member[] {
  return rows.map((row, index) => ({
    membership_id: `demo-${index}`,
    name: row[0] ?? "이름 없음",
    email: row[1] ?? "",
    roles: row[2] ? [row[2]] : [],
    department_id: row[3] ?? null,
    status: row[4] ?? "active",
    title: null,
  }));
}

export function MemberListModal({ session, fallback, onClose }: Props) {
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(onClose);
  const [query, setQuery] = useState("");
  const [members, setMembers] = useState<readonly Member[]>(fallbackMembers(fallback));
  const [loading, setLoading] = useState(Boolean(session));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    apiRequest("/members?limit=500", { session, signal: controller.signal })
      .then((payload) => {
        if (!controller.signal.aborted) setMembers(membersSchema.parse(payload).items);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(userMessageOf(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [session]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ko-KR");
    if (!needle) return members;
    return members.filter((member) =>
      [member.name, member.email, member.title, member.department_id, member.status, ...member.roles]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase("ko-KR").includes(needle)),
    );
  }, [members, query]);

  return (
    <div className="modal-scrim" role="presentation" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal member-modal"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="member-list-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <div>
            <span className="eyebrow">조직 구성</span>
            <h2 id="member-list-title">구성원 목록</h2>
            <p>이름, 이메일, 역할, 부서 또는 상태로 검색할 수 있습니다.</p>
          </div>
          <Button tone="neutral" size="small" onClick={onClose} aria-label="구성원 목록 닫기">닫기</Button>
        </header>

        <div className="member-modal__toolbar">
          <label className="member-modal__search">
            <span>구성원 검색</span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="이름, 이메일, 역할 검색"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <strong aria-live="polite">{query ? `검색 결과 ${filtered.length}명` : `전체 ${filtered.length}명`}</strong>
        </div>

        {error && <div className="form-error" role="alert">{error}</div>}
        {loading ? (
          <p className="modal__loading">구성원 목록을 불러오는 중입니다…</p>
        ) : filtered.length === 0 ? (
          <div className="member-modal__empty">
            <strong>검색 결과가 없습니다.</strong>
            <span>다른 이름, 이메일 또는 역할로 검색해 보세요.</span>
          </div>
        ) : (
          <ul className="member-modal__list" aria-label="구성원">
            {filtered.map((member) => (
              <li key={member.membership_id} className="member-modal__item">
                <span className="member-modal__avatar" aria-hidden="true">{member.name.slice(0, 1)}</span>
                <span className="member-modal__identity">
                  <strong>{member.name}</strong>
                  <span>{member.email}</span>
                </span>
                <span className="member-modal__assignment">
                  <strong>{member.title ?? member.department_id ?? "소속 미지정"}</strong>
                  <span>{member.roles.join(" · ") || "역할 미지정"}</span>
                </span>
                <Badge tone={member.status === "active" ? "success" : "neutral"}>{member.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
