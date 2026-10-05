import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { Empty, PageHead, Pill } from "./mockup/lib";
import { useApi } from "./mockup/useApi";

type Asset = {
  id: string;
  asset_no: string;
  name: string;
  category: string;
  quantity: number;
  threshold: number;
  status: string;
  location: string | null;
  custodian_id: string | null;
  low_stock: boolean;
};
type Member = { user_id: string; name: string };

const STATUS_LABEL: Record<string, string> = {
  available: "사용가능",
  loaned: "대여중",
  in_use: "대여중",
  repair: "수리중",
  under_repair: "수리중",
  damaged: "파손 보고",
  lost: "분실",
  disposed: "폐기",
};
const STATUS_TONE: Record<string, string> = {
  available: "ok",
  loaned: "info",
  in_use: "info",
  repair: "warn",
  under_repair: "warn",
  damaged: "bad",
  lost: "bad",
  disposed: "muted",
};

// AST-001 자산·재고 — 실제 백엔드(/assets) 연동
export function AssetsScreen() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [st, setSt] = useState("");

  const res = useApi<{ items: Asset[] }>("/assets");
  const memberRes = useApi<{ items: Member[] }>("/members");
  const custodian = useMemo(() => {
    const m = new Map((memberRes.data?.items ?? []).map((x) => [x.user_id, x.name]));
    return (id: string | null) => (id ? (m.get(id) ?? "-") : "-");
  }, [memberRes.data]);

  const assets = res.data?.items ?? [];
  const categories = [...new Set(assets.map((a) => a.category))];
  const statuses = [...new Set(assets.map((a) => a.status))];
  const list = assets.filter(
    (a) =>
      (!q || `${a.asset_no} ${a.name} ${a.location ?? ""}`.includes(q)) &&
      (!cat || a.category === cat) &&
      (!st || a.status === st),
  );
  const low = assets.filter((a) => a.low_stock && a.status !== "disposed");

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
            {low.map((a) => `${a.name} ${a.quantity}/${a.threshold}`).join(", ")}
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
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={st} onChange={(e) => setSt(e.target.value)} aria-label="상태">
          <option value="">모든 상태</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s] ?? s}
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
            {res.loading ? (
              <tr>
                <td colSpan={7}>
                  <Empty title="불러오는 중…" icon="clock" />
                </td>
              </tr>
            ) : res.error ? (
              <tr>
                <td colSpan={7}>
                  <Empty title="자산을 불러오지 못했습니다" desc={res.error} icon="alert" />
                </td>
              </tr>
            ) : list.length ? (
              list.map((a) => (
                <tr key={a.id}>
                  <td className="mono xs nowrap">{a.asset_no}</td>
                  <td>
                    <Link className="t-title" to={`/assets/${a.id}`}>
                      {a.name}
                    </Link>
                  </td>
                  <td>{a.category}</td>
                  <td className="muted">{a.location ?? "-"}</td>
                  <td className="nowrap">{custodian(a.custodian_id)}</td>
                  <td className={`num ${a.low_stock ? "ink-bad b" : ""}`}>
                    {a.quantity}
                    {a.threshold > 0 && <span className="sub">최소 {a.threshold}</span>}
                  </td>
                  <td>
                    <Pill tone={STATUS_TONE[a.status] ?? "muted"}>
                      {STATUS_LABEL[a.status] ?? a.status}
                    </Pill>
                  </td>
                </tr>
              ))
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
