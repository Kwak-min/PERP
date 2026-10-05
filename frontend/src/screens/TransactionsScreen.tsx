import { useMemo, useState } from "react";

import { Icon } from "../components/ui/Icon";
import { Empty, PageHead, Pill, Tabs, won } from "./mockup/lib";
import { useApi } from "./mockup/useApi";

type Tx = {
  id: string;
  kind: "income" | "expense";
  account_id: string | null;
  amount_minor: number;
  occurred_on: string;
  memo: string;
  status: string;
  evidence_count: number;
  project_id: string | null;
  ai_generated?: boolean;
};
type Account = { id: string; code: string; name: string; kind: string };

// FIN-002 거래·전표 — 실제 백엔드(/finance/transactions) 연동
export function TransactionsScreen() {
  const [tab, setTab] = useState("list");
  const [st, setSt] = useState("");
  const [type, setType] = useState("");
  const [q, setQ] = useState("");

  const txRes = useApi<{ items: Tx[] }>("/finance/transactions");
  const accRes = useApi<{ items: Account[] }>("/finance/accounts");

  const accById = useMemo(() => {
    const m = new Map((accRes.data?.items ?? []).map((a) => [a.id, a]));
    return (id: string | null) => (id ? m.get(id) : undefined);
  }, [accRes.data]);

  const all = txRes.data?.items ?? [];
  const list = all
    .filter(
      (e) =>
        (!st || e.status === st) &&
        (!type || e.kind === type) &&
        (!q || e.memo.includes(q)),
    )
    .sort((a, b) => b.occurred_on.localeCompare(a.occurred_on));

  const conf = list.filter((e) => e.status === "confirmed");
  const txInc = conf.filter((e) => e.kind === "income").reduce((a, e) => a + e.amount_minor, 0);
  const txExp = conf.filter((e) => e.kind === "expense").reduce((a, e) => a + e.amount_minor, 0);
  const drafts = list.filter((e) => e.status === "draft");

  // 원장: 계정별 집계(확정)
  const ledger = useMemo(() => {
    const map = new Map<string, { account: Account; es: Tx[] }>();
    for (const e of conf) {
      const acc = accById(e.account_id);
      if (!acc) continue;
      const cur = map.get(acc.id) ?? { account: acc, es: [] };
      cur.es.push(e);
      map.set(acc.id, cur);
    }
    return [...map.values()];
  }, [conf, accById]);
  const ledInc = ledger
    .filter((x) => x.account.kind === "income")
    .reduce((a, x) => a + x.es.reduce((s, e) => s + e.amount_minor, 0), 0);
  const ledExp = ledger
    .filter((x) => x.account.kind === "expense")
    .reduce((a, x) => a + x.es.reduce((s, e) => s + e.amount_minor, 0), 0);
  const ok = txInc - txExp === ledInc - ledExp;

  const loading = txRes.loading || accRes.loading;

  return (
    <>
      <PageHead
        title="거래·전표"
        id="FIN-002"
        fr="SFR-010"
        desc="초안(draft) → 확정(confirmed). 확정 전표만 원장·보고서에 반영됩니다."
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
          placeholder="적요 검색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="검색"
        />
      </div>

      {!loading && (
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
              초안 {drafts.length}건({won(drafts.reduce((a, e) => a + e.amount_minor, 0))})은 제외
            </span>
          </div>
        </div>
      )}

      {loading ? (
        <div className="panel">
          <Empty title="불러오는 중…" icon="clock" />
        </div>
      ) : txRes.error ? (
        <div className="panel">
          <Empty title="전표를 불러오지 못했습니다" desc={txRes.error} icon="alert" />
        </div>
      ) : tab === "ledger" ? (
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
                <tr key={x.account.id}>
                  <td className="mono">{x.account.code}</td>
                  <td className="t-title">{x.account.name}</td>
                  <td>
                    <Pill tone={x.account.kind === "income" ? "info" : "muted"}>
                      {x.account.kind === "income" ? "수입" : "지출"}
                    </Pill>
                  </td>
                  <td className="num">{x.es.length}</td>
                  <td className="num">{won(x.es.reduce((s, e) => s + e.amount_minor, 0))}</td>
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
                <th>적요</th>
                <th className="num">금액</th>
                <th>증빙</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {list.length ? (
                list.map((e) => (
                  <tr key={e.id} className={e.status === "draft" ? "is-draft" : ""}>
                    <td className="nowrap tnum">{e.occurred_on}</td>
                    <td>
                      <Pill tone={e.kind === "income" ? "info" : "muted"}>
                        {e.kind === "income" ? "수입" : "지출"}
                      </Pill>
                    </td>
                    <td className="nowrap">{accById(e.account_id)?.name ?? "-"}</td>
                    <td>
                      <span className="t-title">{e.memo || "-"}</span>
                    </td>
                    <td className="num b">
                      {e.kind === "expense" ? "−" : ""}
                      {won(e.amount_minor)}
                    </td>
                    <td>
                      {e.kind === "expense" ? (
                        e.evidence_count > 0 ? (
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
                      {e.ai_generated && (
                        <>
                          {" "}
                          <Pill tone="ai">AI 초안</Pill>
                        </>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7}>
                    <Empty title="조건에 맞는 전표가 없습니다" />
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
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}
