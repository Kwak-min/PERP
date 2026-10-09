import { BrowserRouter, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/layout/AppShell";
import { PublicLayout } from "./components/layout/PublicLayout";
import { AppProvider } from "./context/AppContext";
import { ChangePasswordPage } from "./pages/ChangePasswordPage";
import { InvitationsPage } from "./pages/InvitationsPage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { ScreenPage } from "./pages/ScreenPage";
import { SignupPage } from "./pages/SignupPage";
import { WelcomePage } from "./pages/WelcomePage";
import { screens } from "./routes/catalog";
import { screenOverrides } from "./screens/registry";
import { ProtectedRoute } from "./routes/ProtectedRoute";

export default function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/onboarding/organization" element={<OnboardingPage />} />
          <Route element={<PublicLayout />}>
            <Route path="/welcome" element={<WelcomePage />} />
            <Route path="/invitations" element={<InvitationsPage />} />
            <Route path="/change-password" element={<ChangePasswordPage />} />
          </Route>
          <Route
            element={
              <ProtectedRoute>
                <AppShell />
              </ProtectedRoute>
            }
          >
            {screens.map((screen) => {
              const Screen = screenOverrides[screen.id] ?? ScreenPage;
              return <Route key={screen.path} path={screen.path} element={<Screen screen={screen} />} />;
            })}
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AppProvider>
    </BrowserRouter>
  );
}
