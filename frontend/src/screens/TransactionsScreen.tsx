import { useState } from "react";

import { Icon } from "../components/ui/Icon";
import { demoEntries, type DemoEntry } from "./mockup/demo";
import { Empty, PageHead, Pill, Tabs, won } from "./mockup/lib";

const sum = (list: DemoEntry[]) => list.reduce((a, e) => a + e.amount, 0);

// FIN-002 거래·전표 — 목업 transactions 이식
export function TransactionsScreen() {
  const [tab, setTab] = useState("list");
  const [st, setSt] = useState("");
  const [type, setType] = useState("");
  const [q, setQ] = useState("");

  const list = demoEntries
    .filter(
      (e) =>
        (!st || e.status === st) &&
        (!type || e.type === type) &&
        (!q || `${e.vendor} ${e.memo}`.includes(q)),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

  const conf = list.filter((e) => e.status === "confirmed");
  const txInc = sum(conf.filter((e) => e.type === "income"));
  const txExp = sum(conf.filter((e) => e.type === "expense"));
  const drafts = list.filter((e) => e.status === "draft");

  // 원장: 계정별 집계
  const byAcc = new Map<string, { code: string; type: "income" | "expense"; es: DemoEntry[] }>();
  for (const e of conf) {
    const cur = byAcc.get(e.account) ?? { code: e.accountCode, type: e.type, es: [] };
    cur.es.push(e);
    byAcc.set(e.account, cur);
  }
  const ledger = [...byAcc.entries()].map(([name, v]) => ({ name, ...v }));
  const ledInc = sum(ledger.filter((x) => x.type === "income").flatMap((x) => x.es));
  const ledExp = sum(ledger.filter((x) => x.type === "expense").flatMap((x) => x.es));
  const ok = txInc - txExp === ledInc - ledExp;

  return (
    <>
      <PageHead
        title="거래·전표"
        id="FIN-002"
        fr="SFR-010"
        desc="초안(draft) → 확정(confirmed). 확정 전표만 원장·보고서에 반영됩니다. AI는 초안까지만 만들 수 있습니다."
        actions={
          <>
            <button type="button" className="btn btn-primary">
              <Icon name="plus" />
              전표 초안
            </button>
            <button type="button" className="btn">
              <Icon name="download" />
              CSV
            </button>
          </>
        }
      />
      <Tabs
        items={[
          ["list", "전표", list.length],
          ["ledger", "원장"],
        ]}
        cur={tab}
        onChange={setTab}
      />
      <div className="filters">
        <select value={st} onChange={(e) => setSt(e.target.value)} aria-label="상태">
          <option value="">모든 상태</option>
          <option value="draft">초안</option>
          <option value="confirmed">확정</option>
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="구분">
          <option value="">수입·지출</option>
          <option value="income">수입</option>
          <option value="expense">지출</option>
        </select>
        <input
          type="search"
          placeholder="거래처·적요 검색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="검색"
        />
        {drafts.length > 0 && (
          <>
            <span className="grow" />
            <button type="button" className="btn btn-sm">
              초안 {drafts.length}건 일괄 확정
            </button>
          </>
        )}
      </div>

      <div className={`callout ${ok ? "ok" : "bad"}`} style={{ marginBottom: 12 }}>
        <Icon name={ok ? "check" : "alert"} />
        <div className="recon">
          <b>{ok ? "합계 일치" : "합계 불일치"}</b>
          <span>
            거래 합계 <b>{won(txInc - txExp)}</b>
          </span>
          <span>
            = 원장 합계 <b>{won(ledInc - ledExp)}</b>
          </span>
          <span className="muted">
            초안 {drafts.length}건({won(sum(drafts))})은 제외
          </span>
        </div>
      </div>

      {tab === "ledger" ? (
        <div className="panel tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>코드</th>
                <th>계정과목</th>
                <th>구분</th>
                <th className="num">건수</th>
                <th className="num">합계</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((x) => (
                <tr key={x.name}>
                  <td className="mono">{x.code}</td>
                  <td className="t-title">{x.name}</td>
                  <td>
                    <Pill tone={x.type === "income" ? "info" : "muted"}>
                      {x.type === "income" ? "수입" : "지출"}
                    </Pill>
                  </td>
                  <td className="num">{x.es.length}</td>
                  <td className="num">{won(sum(x.es))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>
                  수지 (수입 {won(ledInc)} − 지출 {won(ledExp)})
                </td>
                <td className="num">{won(ledInc - ledExp)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <div className="panel tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>일자</th>
                <th>구분</th>
                <th>계정</th>
                <th>거래처 · 적요</th>
                <th className="num">금액</th>
                <th>증빙</th>
                <th>상태</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.length ? (
                list.map((e) => (
                  <tr key={e.id} className={e.status === "draft" ? "is-draft" : ""}>
                    <td className="nowrap tnum">{e.date}</td>
                    <td>
                      <Pill tone={e.type === "income" ? "info" : "muted"}>
                        {e.type === "income" ? "수입" : "지출"}
                      </Pill>
                    </td>
                    <td className="nowrap">{e.account}</td>
                    <td>
                      <span className="t-title">{e.vendor}</span>
                      <span className="sub">
                        {e.memo}
                        {e.project ? ` · ${e.project}` : ""}
                      </span>
                    </td>
                    <td className="num b">
                      {e.type === "expense" ? "−" : ""}
                      {won(e.amount)}
                    </td>
                    <td>
                      {e.type === "expense" ? (
                        e.receipt ? (
                          <span className="pill muted">
                            <Icon name="clip" />
                            첨부
                          </span>
                        ) : (
                          <Pill tone="warn">미증빙</Pill>
                        )
                      ) : (
                        <span className="muted xs">-</span>
                      )}
                    </td>
                    <td className="nowrap">
                      {e.status === "confirmed" ? (
                        <Pill tone="ok">확정</Pill>
                      ) : (
                        <Pill tone="warn">초안</Pill>
                      )}
                      {e.ai && (
                        <>
                          {" "}
                          <Pill tone="ai">AI 초안</Pill>
                        </>
                      )}
                    </td>
                    <td className="nowrap">
                      {e.status === "draft" && (
                        <button type="button" className="btn btn-xs btn-primary">
                          확정
                        </button>
                      )}{" "}
                      <button type="button" className="btn btn-xs">
                        수정
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8}>
                    <Empty
                      title="조건에 맞는 전표가 없습니다"
                      desc="기간이나 상태 필터를 바꿔 보세요."
                    />
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>
                  확정 합계 · 수입 {won(txInc)} / 지출 {won(txExp)}
                </td>
                <td className="num">{won(txInc - txExp)}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}
