import { Link, Outlet } from "react-router-dom";

import { Logo } from "../ui/Logo";

export function PublicLayout() {
  return (
    <div className="public-frame">
      <aside className="public-story">
        <Link to="/" aria-label="OrbitFlow 홈"><Logo /></Link>
        <div className="public-story__copy">
          <span className="eyebrow">SMALL ORG, CLEAR FLOW</span>
          <h1>조직 운영의 모든 흐름을 한곳에서.</h1>
          <p>
            업무, 회계, 문서와 AI를 연결하되 권한과 승인 경계는 분명하게 유지합니다.
          </p>
        </div>
        <ul className="trust-list">
          <li><strong>권한 인식</strong><span>역할과 조직 범위 안에서만 조회</span></li>
          <li><strong>승인 우선</strong><span>AI 변경 작업은 실행 전 검토</span></li>
          <li><strong>감사 가능</strong><span>중요 변경은 해시체인으로 기록</span></li>
        </ul>
      </aside>
      <main className="public-main">
        <Outlet />
      </main>
    </div>
  );
}
