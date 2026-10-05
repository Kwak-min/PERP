import { useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "../components/ui/Icon";
import { demoNotes, noteLinks, type DemoNote } from "./mockup/demo";
import { Empty, PageHead } from "./mockup/lib";

// [[위키링크]] 렌더링
function renderWiki(body: string): ReactNode {
  return body.split("\n").map((line, li) => {
    const parts: ReactNode[] = [];
    let last = 0;
    const re = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    let k = 0;
    while ((m = re.exec(line))) {
      if (m.index > last) parts.push(line.slice(last, m.index));
      parts.push(
        <a key={k++} href="#" className="wikilink" onClick={(e) => e.preventDefault()}>
          {m[1]}
        </a>,
      );
      last = m.index + m[0].length;
    }
    if (last < line.length) parts.push(line.slice(last));
    return <p key={li}>{parts.length ? parts : " "}</p>;
  });
}

// VLT-001 개인 Vault — 목업 vaultView 이식
export function VaultScreen() {
  const notes = demoNotes;
  const [selId, setSelId] = useState(notes.find((x) => x.pinned)?.id ?? notes[0]?.id ?? 0);
  const [q, setQ] = useState("");
  const n = notes.find((x) => x.id === selId);
  const list = notes
    .filter((x) => !q || `${x.title} ${x.body}`.includes(q))
    .sort(
      (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
    );
  const folders = [...new Set(notes.map((x) => x.folder))];
  const backlinks = n ? notes.filter((x) => noteLinks(x).includes(n.title)) : [];

  return (
    <>
      <PageHead
        title="개인 Vault"
        id="VLT-001"
        fr="SFR-017"
        desc="나만 볼 수 있는 노트입니다. 같은 조직 구성원이나 관리자도 열 수 없습니다. [[노트 제목]]으로 서로 연결하세요."
        actions={
          <>
            <a className="btn" href="#/vault/graph">
              <Icon name="graph" />
              그래프
            </a>
            <button type="button" className="btn btn-primary">
              <Icon name="plus" />새 노트
            </button>
          </>
        }
      />
      <div className="doc-layout">
        <nav className="panel" style={{ padding: 8, alignSelf: "start" }} aria-label="노트">
          <input
            type="search"
            placeholder="노트 검색"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="노트 검색"
            style={{ marginBottom: 8 }}
          />
          <div className="tree">
            {folders.map((f) => (
              <div key={f}>
                <div className="sec-t" style={{ padding: "6px 8px 2px" }}>
                  {f}
                </div>
                {list
                  .filter((x) => x.folder === f)
                  .map((x) => (
                    <button
                      type="button"
                      key={x.id}
                      className={n?.id === x.id ? "on" : ""}
                      onClick={() => setSelId(x.id)}
                    >
                      <Icon name={x.pinned ? "flag" : "file"} />
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {x.title}
                      </span>
                      {x.agent && (
                        <span className="pill ai" title="Agent 사용 동의">
                          AI
                        </span>
                      )}
                    </button>
                  ))}
              </div>
            ))}
          </div>
        </nav>
        {n ? (
          <div className="grid g-main">
            <div className="stack">
              <div className="row between">
                <input
                  className="doc-title-in"
                  defaultValue={n.title}
                  key={n.id}
                  aria-label="노트 제목"
                  style={{ flex: 1 }}
                />
                <span className="save-state">
                  <Icon name="lock" />
                  소유자 전용
                </span>
              </div>
              <textarea
                className="doc-editor"
                style={{ minHeight: 260 }}
                defaultValue={n.body}
                key={`b${n.id}`}
                aria-label="본문"
              />
              <section className="panel">
                <div className="panel-h">
                  <h2>미리보기</h2>
                  <span className="muted xs">위키링크 렌더링</span>
                </div>
                <div className="panel-b note-body">{renderWiki(n.body)}</div>
              </section>
            </div>
            <aside className="stack">
              <section className="panel">
                <div className="panel-h">
                  <h2>노트 설정</h2>
                </div>
                <div className="panel-b stack">
                  <label className="check">
                    <input type="checkbox" defaultChecked={n.pinned} /> 고정
                  </label>
                  <label className="check">
                    <input type="checkbox" defaultChecked={n.agent} />{" "}
                    <span>
                      Agent 검색에 사용{" "}
                      <span className="hint">(원본 범위 동의 필요 · 개인 등급 → 외부 LLM 차단)</span>
                    </span>
                  </label>
                  <div className="field">
                    <label>폴더</label>
                    <input defaultValue={n.folder} key={`f${n.id}`} />
                  </div>
                  <button type="button" className="btn btn-ghost">
                    <Icon name="trash" />
                    삭제
                  </button>
                </div>
              </section>
              <section className="panel">
                <div className="panel-h">
                  <h2>백링크 {backlinks.length}</h2>
                </div>
                <div className="list">
                  {backlinks.length ? (
                    backlinks.map((b) => (
                      <button
                        type="button"
                        className="li"
                        key={b.id}
                        onClick={() => setSelId(b.id)}
                      >
                        <Icon name="file" />
                        <span className="li-t">
                          <b>{b.title}</b>
                        </span>
                      </button>
                    ))
                  ) : (
                    <Empty title="이 노트를 가리키는 노트가 없습니다" />
                  )}
                </div>
              </section>
            </aside>
          </div>
        ) : (
          <div className="panel">
            <Empty title="노트가 없습니다" desc="첫 노트를 만들어 보세요." />
          </div>
        )}
      </div>
    </>
  );
}

export type { DemoNote };
