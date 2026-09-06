import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, userMessageOf } from "../services/api";
import { useSession } from "../store/session";

import "./orglog.css";

const entrySchema = z.object({
  id: z.string(),
  seq: z.number().catch(0),
  action: z.string(),
  action_label: z.string(),
  resource_type: z.string(),
  resource_id: z.string().nullable().catch(null),
  target: z.string().nullable().catch(null),
  actor_name: z.string().catch("알 수 없음"),
  actor_kind: z.string().catch("user"),
  before: z.record(z.string(), z.unknown()).nullable().catch(null),
  after: z.record(z.string(), z.unknown()).nullable().catch(null),
  created_at: z.string(),
});

const listSchema = z.object({ items: z.array(entrySchema) });

type Entry = z.infer<typeof entrySchema>;

const FIELD_LABELS: Readonly<Record<string, string>> = {
  department_id: "부서",
  title: "직책",
  roles: "역할",
  name: "이름",
  parent_id: "상위 브랜치",
  leader_id: "책임자",
  access_roles: "접근 그룹",
  status: "상태",
};

function short(value: unknown): string {
  if (value === null || value === undefined || value === "") return "없음";
  if (Array.isArray(value)) return value.length === 0 ? "없음" : value.join(", ");
  const text = String(value);
  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
}

/** 변경된 항목만 전/후로 뽑는다. */
function diffOf(entry: Entry): readonly Readonly<{ field: string; before: string; after: string }>[] {
  const keys = [...new Set([...Object.keys(entry.before ?? {}), ...Object.keys(entry.after ?? {})])];
  return keys
    .map((key) => ({
      field: FIELD_LABELS[key] ?? key,
      before: short(entry.before?.[key]),
      after: short(entry.after?.[key]),
    }))
    .filter((row) => row.before !== row.after);
}

export function OrgLogScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const [entries, setEntries] = useState<readonly Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("전체");
  const [reloadKey, setReloadKey] = useState(0);

  const token = session?.token ?? null;
  const orgId = session?.orgId ?? null;

  useEffect(() => {
    if (!token || !orgId) return;
    const controller = new AbortController();
    apiRequest("/pg/members/activity?limit=200", {
      session: { token, orgId },
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) {
          setEntries(listSchema.parse(data).items);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setEntries([]);
          setError(userMessageOf(caught));
        }
      });
    return () => controller.abort();
  }, [token, orgId, reloadKey]);

  const filters = useMemo(() => {
    const labels = [...new Set((entries ?? []).map((entry) => entry.action_label))];
    return ["전체", ...labels];
  }, [entries]);

  const visible = useMemo(
    () => (entries ?? []).filter((entry) => filter === "전체" || entry.action_label === filter),
    [entries, filter],
  );

  return (
    <div className="screen" data-screen-id={screen.id}>
      <header className="screen-header">
        <div>
          <div className="screen-header__meta">
            <span className="eyebrow">사람</span>
            <Badge>{screen.id}</Badge>
            <Badge tone="neutral">감사로그 기반</Badge>
          </div>
          <h1>{screen.label}</h1>
          <p>{screen.description}</p>
        </div>
        <div className="screen-header__actions">
          <Button tone="neutral" size="small" onClick={() => setReloadKey((value) => value + 1)}>
            새로 고침
          </Button>
        </div>
      </header>

      {error && <div className="form-error" role="alert">{error}</div>}

      <SectionCard
        padded
        title="변경 이력"
        subtitle="조직도·구성원·브랜치 변경"
        foot="감사로그는 append-only 이며 삭제할 수 없습니다"
      >
        <div className="orglog-filters">
          {filters.map((label) => (
            <button
              key={label}
              type="button"
              aria-pressed={label === filter}
              className={label === filter ? "chip chip--on" : "chip"}
              onClick={() => setFilter(label)}
            >
              {label}
            </button>
          ))}
          <span className="filter-bar__result">{visible.length}건</span>
        </div>

        {entries === null ? (
          <p className="orglog-empty">변경 이력을 불러오는 중입니다…</p>
        ) : visible.length === 0 ? (
          <p className="orglog-empty">해당 조건의 변경 이력이 없습니다.</p>
        ) : (
          <ol className="orglog-list">
            {visible.map((entry) => {
              const diff = diffOf(entry);
              return (
                <li key={entry.id}>
                  <div className="orglog-item__head">
                    <span className="orglog-item__when">{entry.created_at.replace("T", " ").slice(0, 19)}</span>
                    <b>{entry.action_label}</b>
                    {entry.target && <span className="orglog-item__target">{entry.target}</span>}
                    <span className="orglog-item__actor">
                      {entry.actor_name}
                      {entry.actor_kind !== "user" ? ` (${entry.actor_kind})` : ""}
                    </span>
                  </div>
                  {diff.length > 0 && (
                    <ul className="orglog-item__diff">
                      {diff.map((row) => (
                        <li key={row.field}>
                          <span>{row.field}</span>
                          <del>{row.before}</del>
                          <span aria-hidden="true">→</span>
                          <ins>{row.after}</ins>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </SectionCard>
    </div>
  );
}
