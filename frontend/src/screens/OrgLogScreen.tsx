import { Navigate } from "react-router-dom";
import type { ScreenDefinition } from "../routes/catalog";

// 기존 즐겨찾기는 통합 화면의 팝업으로 연결한다.
export function OrgLogScreen(_props: Readonly<{ screen: ScreenDefinition }>) {
  return <Navigate to="/members?org-log=1" replace />;
}
