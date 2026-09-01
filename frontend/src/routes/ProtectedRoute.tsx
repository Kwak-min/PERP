import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useSession } from "../store/session";

export function ProtectedRoute({ children }: Readonly<{ children: ReactNode }>) {
  const session = useSession();
  const location = useLocation();
  if (!session) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  }
  if (session.mustChangePassword && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }
  if (!session.orgId) return <Navigate to="/welcome" replace />;
  return children;
}
