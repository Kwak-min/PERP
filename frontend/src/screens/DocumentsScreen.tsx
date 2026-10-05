import { useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { demoDocs, docSpaces } from "./mockup/demo";
import { Empty, GradeChip, PageHead } from "./mockup/lib";

// DOC-001 문서·지식 — 목업 documents 이식
export function DocumentsScreen() {
  const [space, setSpace] = useState("");
  const [fav, setFav] = useState(false);
  const [q, setQ] = useState("");

  const list = demoDocs
    .filter(
      (d) =>
        (!space || d.space === space) &&
        (!fav || d.fav) &&
        (!q || `${d.title} ${d.snippet}`.includes(q)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <>
      <PageHead
        title="문서·지식"
        id="DOC-001"
        fr="SFR-017"
        desc="문서 제목·본문·태그를 함께 검색합니다. 데이터 등급(공개·내부·개인·민감·고기밀)에 따라 볼 수 있는 문서가 다릅니다."
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
        <nav className="panel" style={{ padding: 8, alignSelf: "start" }} aria-label="문서 공간">
          <div className="tree">
            <button
              type="button"
              className={!space && !fav ? "on" : ""}
              onClick={() => {
                setSpace("");
                setFav(false);
              }}
            >
              <Icon name="folder" />
              전체 문서
            </button>
            <button type="button" className={fav ? "on" : ""} onClick={() => setFav(true)}>
              <Icon name="bookmark" />
              즐겨찾기
            </button>
            {docSpaces.map((s) => (
              <button
                type="button"
                key={s}
                className={space === s ? "on" : ""}
                onClick={() => {
                  setSpace(s);
                  setFav(false);
                }}
              >
                <Icon name="folder" />
                {s}
                <span className="muted xs" style={{ marginLeft: "auto" }}>
                  {demoDocs.filter((d) => d.space === s).length}
                </span>
              </button>
            ))}
            <button type="button">
              <Icon name="trash" />
              보관함
            </button>
          </div>
        </nav>
        <div className="stack">
          <div className="filters" style={{ margin: 0 }}>
            <input
              type="search"
              placeholder="문서·첨부 통합 검색"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="문서 검색"
              style={{ flex: 1 }}
            />
          </div>
          <div className="callout info">
            <Icon name="lock" />
            <div>권한 밖 문서는 목록·검색·AI 답변 어디에도 나타나지 않습니다. (현재 역할: 운영진)</div>
          </div>
          <div className="panel">
            <div className="list">
              {list.length ? (
                list.map((d) => (
                  <div className="li" key={d.id}>
                    <Link className="li-t" to={`/documents/${d.id}`}>
                      <b>
                        {d.title}
                        {d.ai && <span className="pill ai"> AI 작성 포함</span>}
                      </b>
                      <small>{d.snippet}</small>
                      <small>
                        {d.space} · {d.by} · {d.updatedAt}
                      </small>
                    </Link>
                    <GradeChip grade={d.grade} />
                    <button
                      type="button"
                      className="icon-btn sm"
                      aria-pressed={!!d.fav}
                      aria-label="즐겨찾기"
                      style={d.fav ? { color: "var(--of-warning)" } : undefined}
                    >
                      <Icon name="bookmark" />
                    </button>
                    <button type="button" className="btn btn-xs btn-ghost">
                      보관
                    </button>
                  </div>
                ))
              ) : (
                <Empty title="문서가 없습니다" desc="새 문서를 만들거나 .md 파일을 가져오세요." />
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
