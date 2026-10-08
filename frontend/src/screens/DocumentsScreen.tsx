import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { Empty, GradeChip, PageHead } from "./mockup/lib";
import { useApi } from "./mockup/useApi";

type Doc = {
  id: string;
  title: string;
  doc_type: string;
  tags: string[];
  sensitivity: string;
  owner_id: string | null;
  archived: boolean;
  review_status: string;
  ai_generated?: boolean;
};
type Member = { user_id: string; name: string };

const GRADE: Record<string, string> = {
  public: "공개",
  internal: "내부",
  personal: "개인",
  sensitive: "민감",
  confidential: "고기밀",
};

// DOC-001 문서·지식 — 실제 백엔드(/documents) 연동
export function DocumentsScreen() {
  const [sens, setSens] = useState("");
  const [q, setQ] = useState("");

  const res = useApi<{ items: Doc[] }>("/documents");
  const memberRes = useApi<{ items: Member[] }>("/members");
  const ownerName = useMemo(() => {
    const m = new Map((memberRes.data?.items ?? []).map((x) => [x.user_id, x.name]));
    return (id: string | null) => (id ? (m.get(id) ?? "-") : "-");
  }, [memberRes.data]);

  const docs = (res.data?.items ?? []).filter((d) => !d.archived);
  const sensitivities = [...new Set(docs.map((d) => d.sensitivity))];
  const list = docs.filter(
    (d) => (!sens || d.sensitivity === sens) && (!q || d.title.includes(q)),
  );

  return (
    <>
      <PageHead
        title="문서·지식"
        id="DOC-001"
        fr="SFR-017"
        desc="문서 제목·태그로 검색합니다. 데이터 등급(공개·내부·개인·민감·고기밀)에 따라 볼 수 있는 문서가 다릅니다."
        actions={
          <>
            <label className="btn">
              <Icon name="upload" />
              가져오기
            </label>
            <button type="button" className="btn btn-primary">
              <Icon name="plus" />새 문서
            </button>
          </>
        }
      />
      <div className="doc-layout">
        <nav className="panel" style={{ padding: 8, alignSelf: "start" }} aria-label="문서 등급">
          <div className="tree">
            <button type="button" className={!sens ? "on" : ""} onClick={() => setSens("")}>
              <Icon name="folder" />
              전체 문서
              <span className="muted xs" style={{ marginLeft: "auto" }}>
                {docs.length}
              </span>
            </button>
            {sensitivities.map((s) => (
              <button
                type="button"
                key={s}
                className={sens === s ? "on" : ""}
                onClick={() => setSens(s)}
              >
                <Icon name="file" />
                {GRADE[s] ?? s}
                <span className="muted xs" style={{ marginLeft: "auto" }}>
                  {docs.filter((d) => d.sensitivity === s).length}
                </span>
              </button>
            ))}
          </div>
        </nav>
        <div className="stack">
          <div className="filters" style={{ margin: 0 }}>
            <input
              type="search"
              placeholder="문서 검색"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="문서 검색"
              style={{ flex: 1 }}
            />
          </div>
          <div className="callout info">
            <Icon name="lock" />
            <div>권한 밖 문서는 목록·검색·AI 답변 어디에도 나타나지 않습니다.</div>
          </div>
          <div className="panel">
            <div className="list">
              {res.loading ? (
                <Empty title="불러오는 중…" icon="clock" />
              ) : list.length ? (
                list.map((d) => (
                  <div className="li" key={d.id}>
                    <Link className="li-t" to={`/documents/${d.id}`}>
                      <b>
                        {d.title}
                        {d.ai_generated && <span className="pill ai"> AI 작성 포함</span>}
                      </b>
                      <small>
                        {d.doc_type}
                        {d.tags.length ? ` · ${d.tags.join(", ")}` : ""}
                      </small>
                      <small>{ownerName(d.owner_id)}</small>
                    </Link>
                    <GradeChip grade={GRADE[d.sensitivity] ?? d.sensitivity} />
                    <button type="button" className="icon-btn sm" aria-label="즐겨찾기">
                      <Icon name="bookmark" />
                    </button>
                  </div>
                ))
              ) : (
                <Empty title="문서가 없습니다" desc="새 문서를 만들거나 가져오세요." />
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
