import type { ReactNode } from "react";

import { type ApiError, userMessageOf } from "../../services/api";
import { Button } from "../ui/Button";

type StateBoundaryProps = Readonly<{
  status: "idle" | "loading" | "ready" | "empty" | "forbidden" | "error";
  error: Error | ApiError | null;
  children: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
}>;

export function StateBoundary({
  status,
  error,
  children,
  emptyTitle = "아직 표시할 항목이 없습니다",
  emptyDescription = "첫 항목을 추가하면 이곳에서 바로 확인할 수 있습니다.",
}: StateBoundaryProps) {
  if (status === "loading") {
    return (
      <div className="state-card" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <strong>조직 데이터를 불러오는 중</strong>
        <p>권한과 최신 상태를 확인하고 있습니다.</p>
      </div>
    );
  }
  if (status === "forbidden") {
    return (
      <div className="state-card state-card--warning" role="alert">
        <span className="state-card__icon" aria-hidden="true">!</span>
        <strong>이 화면을 볼 권한이 없습니다</strong>
        <p>{error?.message ?? "조직 관리자에게 필요한 권한을 요청하세요."}</p>
        <Button tone="neutral" size="small" onClick={() => history.back()}>
          이전 화면
        </Button>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="state-card state-card--danger" role="alert">
        <span className="state-card__icon" aria-hidden="true">×</span>
        <strong>데이터를 불러오지 못했습니다</strong>
        <p>{userMessageOf(error)}</p>
        <Button size="small" onClick={() => location.reload()}>
          다시 시도
        </Button>
      </div>
    );
  }
  if (status === "empty") {
    return (
      <div className="state-card">
        <span className="state-card__icon" aria-hidden="true">＋</span>
        <strong>{emptyTitle}</strong>
        <p>{emptyDescription}</p>
      </div>
    );
  }
  return children;
}
