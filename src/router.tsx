import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Navigate,
  Outlet,
  createBrowserRouter,
  useLocation,
} from "react-router";

import { useAuth } from "@/lib/auth";
import { getSetupStatus, type SetupStatus } from "@/lib/setup";

function SetupBoundary() {
  const location = useLocation();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setError(null);
    try {
      setStatus(await getSetupStatus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法检查初始化状态");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void check(), 0);
    return () => window.clearTimeout(timer);
  }, [check]);

  if (error) {
    return (
      <main className="grid min-h-dvh place-items-center p-4">
        <div className="grid w-full max-w-md gap-3">
          <div
            className="rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-5 text-center text-sm text-destructive"
            role="alert"
          >
            {error}
          </div>
          <button
            className="inline-flex h-9 items-center justify-center rounded-md border bg-background px-4 text-sm font-medium transition-colors hover:bg-muted"
            type="button"
            onClick={() => void check()}
          >
            重新连接后端
          </button>
        </div>
      </main>
    );
  }
  if (!status) {
    return (
      <main className="grid min-h-dvh place-items-center p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          正在检查初始化状态
        </div>
      </main>
    );
  }

  if (status.setupRequired && location.pathname !== "/setup") {
    return <Navigate to="/setup" replace />;
  }
  if (!status.setupRequired && location.pathname === "/setup") {
    return <Navigate to="/login" replace />;
  }
  return <Outlet context={status} />;
}

function ProtectedRoute() {
  const { ready, user } = useAuth();
  const location = useLocation();
  if (!ready) {
    return (
      <main className="grid min-h-dvh place-items-center p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          正在恢复会话
        </div>
      </main>
    );
  }
  if (!user) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <Outlet />;
}

function AdminRoute() {
  const { user } = useAuth();
  return user?.role === "admin" ? (
    <Outlet />
  ) : (
    <Navigate to="/dashboard" replace />
  );
}

export const router = createBrowserRouter([
  {
    Component: SetupBoundary,
    children: [
      {
        path: "/setup",
        lazy: async () => {
          const module = await import("@/pages/setup");
          return { Component: module.SetupPage };
        },
      },
      {
        path: "/login",
        lazy: async () => {
          const module = await import("@/pages/login");
          return { Component: module.LoginPage };
        },
      },
      {
        path: "/register",
        lazy: async () => {
          const module = await import("@/pages/register");
          return { Component: module.RegisterPage };
        },
      },
      {
        Component: ProtectedRoute,
        children: [
          {
            lazy: async () => {
              const module = await import("@/components/app-shell");
              return { Component: module.AppShell };
            },
            children: [
              { index: true, element: <Navigate to="/dashboard" replace /> },
              {
                path: "/dashboard",
                lazy: async () => {
                  const module = await import("@/pages/dashboard");
                  return { Component: module.DashboardPage };
                },
              },
              {
                path: "/keys",
                lazy: async () => {
                  const module = await import("@/pages/api-keys");
                  return { Component: module.ApiKeysPage };
                },
              },
              {
                path: "/logs",
                lazy: async () => {
                  const module = await import("@/pages/logs");
                  return { Component: module.LogsPage };
                },
              },
              {
                path: "/usage",
                lazy: async () => {
                  const module = await import("@/pages/my-usage");
                  return { Component: module.MyUsagePage };
                },
              },
              {
                Component: AdminRoute,
                children: [
                  {
                    path: "/accounts",
                    lazy: async () => {
                      const module = await import("@/pages/accounts");
                      return { Component: module.AccountsPage };
                    },
                  },
                  {
                    path: "/users",
                    lazy: async () => {
                      const module = await import("@/pages/users");
                      return { Component: module.UsersPage };
                    },
                  },
                ],
              },
              {
                path: "*",
                lazy: async () => {
                  const module = await import("@/pages/not-found");
                  return { Component: module.NotFoundPage };
                },
              },
            ],
          },
        ],
      },
    ],
  },
]);
