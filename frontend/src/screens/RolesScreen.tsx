import { Fragment, useState } from "react";

import { Icon } from "../components/ui/Icon";
import { PERMS, PERM_GROUPS, ROLE_DEFS, roleHas } from "./mockup/rbac";
import { Empty, PageHead, Tabs } from "./mockup/lib";

// ORG-004 역할·권한 관리 — 목업 roles 이식
export function RolesScreen() {
  const [tab, setTab] = useState("edit");
  const [selKey, setSelKey] = useState("treasurer");
  const sel = ROLE_DEFS.find((r) => r.key === selKey) ?? ROLE_DEFS[0]!;
  const locked = sel.key === "owner";

  return (
    <>
      <PageHead
        title="역할·권한 관리"
        id="ORG-004"
        fr="SFR-004"
        desc="서버 RBAC가 리소스·행동·범위·필드 마스킹을 판정합니다. 메뉴 숨김은 보조일 뿐입니다. 저장은 버전 토큰(expected_version)으로 동시 수정을 막습니다."
      />
      <Tabs
        items={[
          ["edit", "역할 편집"],
          ["matrix", "전체 매트릭스"],
          ["sim", "권한 시뮬레이션"],
        ]}
        cur={tab}
        onChange={setTab}
      />

      {tab === "matrix" ? (
        <div className="panel tbl-wrap">
          <table className="tbl matrix">
            <thead>
              <tr>
                <th>권한</th>
                {ROLE_DEFS.map((r) => (
                  <th className="rot" key={r.key}>
                    {r.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERM_GROUPS.map(([g, ps]) => (
                <Fragment key={g}>
                  <tr className="grp">
                    <td colSpan={ROLE_DEFS.length + 1}>{g}</td>
                  </tr>
                  {ps.map((p) => (
                    <tr key={p}>
                      <td>
                        {PERMS[p]} <span className="mono xs muted">{p}</span>
                      </td>
                      {ROLE_DEFS.map((r) => (
                        <td className="c" key={r.key}>
                          {roleHas(r, p) ? (
                            <span className="ink-ok" aria-label="허용">
                              ●
                            </span>
                          ) : (
                            <span className="muted" aria-label="없음">
                              ·
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : tab === "sim" ? (
        <div className="grid g2">
          <section className="panel">
            <div className="panel-h">
              <h2>POST /permissions/simulate</h2>
            </div>
            <form className="panel-b stack" onSubmit={(e) => e.preventDefault()}>
              <div className="field">
                <label>사용자</label>
                <select defaultValue="김민지">
                  <option>김민지</option>
                  <option>박준호</option>
                  <option>정하늘</option>
                </select>
              </div>
              <div className="field">
                <label>권한</label>
                <select defaultValue="finance.write">
                  {PERM_GROUPS.map(([g, ps]) => (
                    <optgroup label={g} key={g}>
                      {ps.map((p) => (
                        <option key={p} value={p}>
                          {PERMS[p]} ({p})
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <button className="btn btn-primary" type="submit">
                시뮬레이션
              </button>
              <p className="hint">실제 권한을 바꾸지 않고 판정 과정만 보여 줍니다.</p>
            </form>
          </section>
          <section className="panel">
            <div className="panel-h">
              <h2>판정 결과</h2>
            </div>
            <div className="panel-b">
              <Empty
                title="사용자와 권한을 고르세요"
                desc="7단계 판정 순서(인증→조직→역할→범위→필드→채널→감사)를 보여 줍니다."
              />
            </div>
          </section>
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "minmax(0,260px) minmax(0,1fr)" }}>
          <section className="panel" style={{ alignSelf: "start" }}>
            <div className="list">
              {ROLE_DEFS.map((r) => (
                <button
                  type="button"
                  key={r.key}
                  className={`li pop-i${r.key === sel.key ? " on" : ""}`}
                  onClick={() => setSelKey(r.key)}
                >
                  <span className="li-t">
                    <b>{r.name}</b>
                    <small>
                      {r.count}명 · v{r.version}
                    </small>
                  </span>
                  {r.key === "owner" && <Icon name="lock" />}
                </button>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="panel-h">
              <h2>
                {sel.name} <span className="mono xs muted">v{sel.version}</span>
              </h2>
              {!locked && (
                <div className="row">
                  <button type="button" className="btn btn-sm btn-primary" disabled>
                    변경 저장
                  </button>
                </div>
              )}
            </div>
            <div className="panel-b stack">
              <p className="muted sm">{sel.desc}</p>
              {locked && (
                <div className="callout info">
                  <Icon name="lock" />
                  <div>기본 역할 보호 — 조직 소유자는 모든 권한을 가지며 편집할 수 없습니다.</div>
                </div>
              )}
              {PERM_GROUPS.map(([g, ps]) => (
                <fieldset key={g} style={{ border: 0, padding: 0, margin: 0 }}>
                  <legend className="sec-t">{g}</legend>
                  <div className="grid g2" style={{ gap: "6px 16px" }}>
                    {ps.map((p) => (
                      <label className="check" key={p}>
                        <input type="checkbox" defaultChecked={roleHas(sel, p)} disabled={locked} />{" "}
                        <span>
                          {PERMS[p]} <span className="mono xs muted">{p}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
