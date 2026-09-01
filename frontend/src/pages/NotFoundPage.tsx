import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <main className="not-found">
      <span className="eyebrow">404 · NOT FOUND</span>
      <h1>요청한 화면을 찾을 수 없습니다</h1>
      <p>주소가 바뀌었거나 접근할 수 없는 화면입니다.</p>
      <Link className="button button--primary button--medium" to="/">홈으로 이동</Link>
    </main>
  );
}
