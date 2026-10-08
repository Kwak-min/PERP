import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { PageHead, Pill, StatTile, num, pct } from "./mockup/lib";

const HEALTH: Array<[string, string, string]> = [
  ["ERP API", "GET /health", "status=ok, service=orbitflow-backend"],
  ["Route 카탈로그", "GET /api/v1/routes", "prefix=/api/v1, 21그룹"],
  ["perp_db", "GET /api/v1/pg/health", "status=ok, database=perp_db"],
  ["예약 서비스", "GET /health (예약)", "status=ok"],
  ["감사 체인", "GET /integrations/audit/verify", "valid=true"],
];

const MENU: Array<[string, string, string]> = [
  ["/admin/audit", "감사 로그", "불변 이벤트 · 해시체인 검증"],
  ["/admin/ai-policy", "AI 정책·모델", "데이터 등급 라우팅 · 도구 허용 목록 · 비용"],
  ["/admin/data", "데이터 보존·내보내기", "보존 정책 · 비동기 내보내기 · 탈퇴 처리"],
  ["/settings/roles", "역할·권한", "권한 매트릭스 · 시뮬레이션"],
  ["/settings/integrations", "연동 센터", "OAuth 범위 · 토큰 폐기"],
];

// ADM-001 관리자 콘솔 — 목업 admin 이식
export function AdminScreen() {
  const costUsed = 18400,
    costLimit = 30000;
  return (
    <>
      <PageHead
        title="관리자 콘솔"
        id="ADM-001 · ADM-005"
        fr="SFR-029"
        desc="조직 운영 상태·사용량·요금제를 한곳에서 봅니다. 위험 작업은 재인증 후 실행됩니다."
      />
      <div className="stats" style={{ marginBottom: 16 }}>
        <StatTile label="좌석" value="18 / 50" sub="교육 무료 요금제" />
        <StatTile label="저장공간" value="0.4GiB / 5GiB" sub="원증빙·문서 원본" />
        <StatTile
          label="AI 비용 (월)"
          value={`₩${num(costUsed)}`}
          sub={`한도 ₩${num(costLimit)} · ${pct(costUsed, costLimit)}%`}
          tone={pct(costUsed, costLimit) >= 90 ? "warn" : ""}
        />
        <StatTile label="자동화 실행" value="42회" sub="실패 1" />
      </div>
      <div className="grid g2">
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="cpu" />
              서비스 상태
            </h2>
            <span className="muted xs">목업: 브라우저 내부 시뮬레이션</span>
          </div>
          <div className="list">
            {HEALTH.map(([n, e, s]) => (
              <div className="li" key={n}>
                <Pill tone="ok">정상</Pill>
                <span className="li-t">
                  <b>{n}</b>
                  <small className="mono">
                    {e} → {s}
                  </small>
                </span>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="coins" />
              요금제
            </h2>
          </div>
          <div className="panel-b stack">
            <div className="grid g2">
              <div className="panel" style={{ padding: 14, borderColor: "var(--of-primary)" }}>
                <b>교육 무료</b>
                <p className="sm muted">동아리·학생회·연구실 · 50석 · AI 월 ₩30,000 한도</p>
                <Pill tone="info">현재 요금제</Pill>
              </div>
              <div className="panel" style={{ padding: 14 }}>
                <b>기업</b>
                <p className="sm muted">좌석 과금 · 자동화·연동 무제한 · SSO</p>
                <button type="button" className="btn btn-sm">
                  문의
                </button>
              </div>
            </div>
            <p className="hint">결제 수단 등록·실제 결제는 목업 범위 밖입니다.</p>
          </div>
        </section>
      </div>
      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h">
          <h2>관리 메뉴</h2>
        </div>
        <div className="list">
          {MENU.map(([h, t, d]) => (
            <Link className="li" to={h} key={h}>
              <Icon name="right" />
              <span className="li-t">
                <b>{t}</b>
                <small>{d}</small>
              </span>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
