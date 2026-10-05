import { Icon } from "../components/ui/Icon";
import { duesCharges, duesPayers, duesStatusMap } from "./mockup/demo";
import { Av, PageHead, StatTile, maskPhone, pct, todayStr, won } from "./mockup/lib";

// FIN-004 회비·청구 — 목업 dues 이식
export function DuesScreen() {
  const pii = false;
  const ch = [...duesCharges].sort((a, b) => a.due.localeCompare(b.due));

  // 요약
  let paid = 0,
    target = 0,
    unpaidAmt = 0;
  const unpaidPeople = new Set<string>();
  for (const c of ch) {
    for (const u of duesPayers) {
      const s = duesStatusMap[c.id]?.[u.name] ?? "unpaid";
      if (s === "exempt") continue;
      target += 1;
      if (s === "paid") paid += 1;
      else {
        unpaidAmt += c.amount;
        unpaidPeople.add(u.name);
      }
    }
  }
  const rate = pct(paid, target);

  return (
    <>
      <PageHead
        title="회비·청구"
        id="FIN-004"
        fr="SFR-012"
        desc="납부 여부만 기록합니다 (실제 이체·PG 결제는 범위 외). 칸을 누르면 납부·면제를 기록하고, 납부는 수입 전표로 자동 확정됩니다."
        actions={
          <>
            <button type="button" className="btn">
              <Icon name="plus" />
              청구 추가
            </button>
            <button type="button" className="btn btn-primary">
              <Icon name="bell" />
              미납 알림 보내기
            </button>
          </>
        }
      />
      <div className="stats" style={{ marginBottom: 16 }}>
        <StatTile label="납부율" value={`${rate}%`} sub={`${paid} / ${target}건 (면제 제외)`} />
        <StatTile
          label="미납액"
          value={won(unpaidAmt)}
          sub={`${unpaidPeople.size}명`}
          tone={unpaidAmt ? "warn" : ""}
        />
        <StatTile label="청구 항목" value={`${ch.length}개`} />
      </div>
      <div className="panel tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>구성원</th>
              <th>연락처{pii ? "" : " (마스킹)"}</th>
              {ch.map((c) => (
                <th key={c.id} className="num" style={{ minWidth: 110 }}>
                  {c.name}
                  <span className="sub">
                    {won(c.amount)} · {c.due.slice(5)} 기한
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {duesPayers.map((u) => (
              <tr key={u.name}>
                <td className="nowrap">
                  <Av name={u.name} size="sm" /> {u.name}
                </td>
                <td className="mono xs nowrap">{pii ? u.phone : maskPhone(u.phone)}</td>
                {ch.map((c) => {
                  const s = duesStatusMap[c.id]?.[u.name] ?? "unpaid";
                  const late = s === "unpaid" && c.due < todayStr;
                  return (
                    <td key={c.id}>
                      <button type="button" className={`dues-cell ${s}`}>
                        {s === "paid"
                          ? "✓ 납부"
                          : s === "exempt"
                            ? "면제"
                            : late
                              ? "! 연체"
                              : "미납"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>납부율</td>
              {ch.map((c) => {
                const tgt = duesPayers.filter(
                  (u) => (duesStatusMap[c.id]?.[u.name] ?? "unpaid") !== "exempt",
                );
                const pd = tgt.filter((u) => duesStatusMap[c.id]?.[u.name] === "paid").length;
                return (
                  <td key={c.id} className="num">
                    {pct(pd, tgt.length)}%{" "}
                    <span className="muted xs">
                      ({pd}/{tgt.length})
                    </span>
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        연락처는 개인 등급 데이터라 '개인정보 열람' 권한이 없으면 마스킹됩니다. 권한·내보내기·로그·AI 4경로에서 같은
        규칙을 적용합니다.
      </p>
    </>
  );
}
