import { LinkProvider } from "@cloudflare/kumo/utils";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppLink } from "./components/AppLink";
import { AppShell } from "./components/AppShell";
import { ModalRoot } from "./components/ModalRoot";
import { AgentsMdPage } from "./pages/AgentsMdPage";
import { DashboardPage } from "./pages/DashboardPage";
import { EntityDetailPage } from "./pages/EntityDetailPage";
import { InboxPage } from "./pages/InboxPage";
import { LoginPage } from "./pages/LoginPage";
import { OkrPage } from "./pages/OkrPage";
import { ProjectPage } from "./pages/ProjectPage";
import { SearchPage } from "./pages/SearchPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TasksPage } from "./pages/TasksPage";
import { TodayPage } from "./pages/TodayPage";
import { TrashPage } from "./pages/TrashPage";
import { ModalsProvider } from "./state/modals";
import { ToastsProvider } from "./state/toasts";

export default function App() {
  return (
    <LinkProvider component={AppLink}>
      <ToastsProvider>
        <ModalsProvider>
          <Routes>
            {/* Login lives outside AppShell so the sidebar/topbar don't render
                while unauthenticated. */}
            <Route path="/login" element={<LoginPage />} />
            <Route element={<AppShell />}>
              <Route path="/" element={<TasksPage />} />
              <Route path="/today" element={<TodayPage />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/okr" element={<OkrPage />} />
              <Route path="/trash" element={<TrashPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/p/:key" element={<ProjectPage />} />
              <Route path="/p/:key/e/:id" element={<EntityDetailPage />} />
              <Route path="/p/:key/agents-md" element={<AgentsMdPage />} />
              <Route path="/search" element={<SearchPage />} />
            </Route>
            {/* Tasks lives at "/"; send stale or mistyped paths there instead
                of rendering an empty shell. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <ModalRoot />
        </ModalsProvider>
      </ToastsProvider>
    </LinkProvider>
  );
}
