import { useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import {
  AST_TONE,
  assetCategories,
  assetStatuses,
  demoAssets,
} from "./mockup/demo";
import { Empty, PageHead, Pill } from "./mockup/lib";

// AST-001 자산·재고 — 목업 assetsView() 이식
export function AssetsScreen() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [st, setSt] = useState("");

  const list = demoAssets.filter(
    (a) =>
      (a.status !== "폐기" || st === "폐기") &&
      (!q || `${a.code} ${a.name} ${a.location}`.includes(q)) &&
      (!cat || a.category === cat) &&
      (!st || a.status === st),
  );
  const low = demoAssets.filter((a) => a.minQty && a.qty < a.minQty && a.status !== "폐기");

  return (
    <>
      <PageHead
        title="자산·재고"
        id="AST-001"
        fr="SFR-014"
        desc="자산번호·위치·책임자·수량을 관리합니다. 소모품은 최소 수량 아래로 떨어지면 알림이 갑니다."
        actions={
          <>
            <button type="button" className="btn">
              <Icon name="upload" />
              일괄 등록
            </button>
            <button type="button" className="btn btn-primary">
              <Icon name="plus" />
              자산 등록
            </button>
          </>
        }
      />
      {low.length > 0 && (
        <div className="callout warn" style={{ marginBottom: 12 }}>
          <Icon name="alert" />
          <div>
            <b>재고 임계치 미만 {low.length}건</b> —{" "}
            {low.map((a) => `${a.name} ${a.qty}/${a.minQty}`).join(", ")}
          </div>
        </div>
      )}
      <div className="filters">
        <input
          type="search"
          placeholder="자산번호·이름·위치"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="검색"
        />
        <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="분류">
          <option value="">모든 분류</option>
          {assetCategories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={st} onChange={(e) => setSt(e.target.value)} aria-label="상태">
          <option value="">모든 상태</option>
          {assetStatuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="panel tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>자산번호</th>
              <th>이름</th>
              <th>분류</th>
              <th>위치</th>
              <th>책임자</th>
              <th className="num">수량</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {list.length ? (
              list.map((a) => {
                const lowQ = a.minQty && a.qty < a.minQty;
                return (
                  <tr key={a.id}>
                    <td className="mono xs nowrap">{a.code}</td>
                    <td>
                      <Link className="t-title" to={`/assets/${a.id}`}>
                        {a.name}
                      </Link>
                    </td>
                    <td>{a.category}</td>
                    <td className="muted">{a.location}</td>
                    <td className="nowrap">{a.owner}</td>
                    <td className={`num ${lowQ ? "ink-bad b" : ""}`}>
                      {a.qty}
                      {a.minQty && <span className="sub">최소 {a.minQty}</span>}
                    </td>
                    <td>
                      <Pill tone={AST_TONE[a.status]}>{a.status}</Pill>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={7}>
                  <Empty title="조건에 맞는 자산이 없습니다" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
