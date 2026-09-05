import {
  Check,
  CircleUserRound,
  Gauge,
  Hexagon,
  KeyRound,
  LogOut,
  Monitor,
  Wallet,
  Moon,
  Sun,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";

import codexShellLogoUrl from "@/assets/codex-shell-logo.svg";
import { Tooltip } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { Avatar, AvatarFallback } from "@/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/components/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/ui/components/sidebar";
import { FullScreenSpinner } from "@/ui/components/spinner";
import {
  ThemeToggler,
  type Resolved,
  type ThemeSelection,
} from "@/ui/components/theme-toggler";
import { cn } from "@/ui/lib/utils";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  section: "workspace" | "management";
  adminOnly?: boolean;
};

function OpenAIIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934A4.1 4.1 0 0 0 8.423.2 4.15 4.15 0 0 0 6.305.086a4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679A4 4 0 0 0 .554 4.72a3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z" />
    </svg>
  );
}

const navItems: NavItem[] = [
  { href: "/dashboard", label: "仪表盘", icon: Gauge, section: "workspace" },
  {
    href: "/accounts",
    label: "OpenAI 账号",
    icon: OpenAIIcon,
    section: "workspace",
    adminOnly: true,
  },
  { href: "/logs", label: "请求日志", icon: Hexagon, section: "workspace" },
  {
    href: "/usage",
    label: "额度信息",
    icon: Wallet,
    section: "workspace",
  },
  { href: "/keys", label: "API Keys", icon: KeyRound, section: "workspace" },
  {
    href: "/users",
    label: "用户管理",
    icon: CircleUserRound,
    section: "management",
    adminOnly: true,
  },
];

function readTheme(): ThemeSelection {
  const saved = window.localStorage.getItem("cocodex.theme");
  return saved === "light" || saved === "dark" || saved === "system"
    ? saved
    : "system";
}

function systemTheme(): Resolved {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function useTheme() {
  const [theme, setThemeState] = useState<ThemeSelection>(readTheme);
  const [resolvedTheme, setResolvedTheme] = useState<Resolved>(() =>
    theme === "system" ? systemTheme() : theme,
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const resolved = theme === "system" ? systemTheme() : theme;
      setResolvedTheme(resolved);
      document.documentElement.classList.toggle("dark", resolved === "dark");
      document.documentElement.style.colorScheme = resolved;
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [theme]);

  const setTheme = (next: ThemeSelection) => {
    window.localStorage.setItem("cocodex.theme", next);
    setThemeState(next);
  };

  return { theme, resolvedTheme, setTheme };
}

export function AppShell() {
  const { user } = useAuth();
  const location = useLocation();
  const [isNavigating, setIsNavigating] = useState(false);
  const lastPath = useRef(location.pathname);
  const visibleNavItems = useMemo(
    () => navItems.filter((item) => !item.adminOnly || user?.role === "admin"),
    [user?.role],
  );

  useEffect(() => {
    if (lastPath.current !== location.pathname) {
      lastPath.current = location.pathname;
      setIsNavigating(false);
    }
  }, [location.pathname]);

  return (
    <SidebarProvider defaultOpen className="h-svh overflow-hidden">
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col pt-12">
        <TopNavbar items={visibleNavItems} />
        <div className="flex min-h-0 w-full min-w-0 flex-1">
          <AppNav
            items={visibleNavItems}
            pathname={location.pathname}
            onNavigate={() => setIsNavigating(true)}
          />
          <SidebarInset className="min-w-0">
            <section className="relative min-h-0 flex-1 overflow-y-auto">
              {isNavigating ? <FullScreenSpinner label="正在切换页面" /> : null}
              <Outlet />
            </section>
          </SidebarInset>
        </div>
      </div>
    </SidebarProvider>
  );
}

function TopNavbar({ items }: { items: NavItem[] }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const active = items.find(
    (item) =>
      item.href === location.pathname ||
      location.pathname.startsWith(`${item.href}/`),
  );
  const initial = user?.username.slice(0, 1).toUpperCase() || "?";
  const color = getAvatarColor(user?.username || "");

  return (
    <header className="fixed inset-x-0 top-0 z-30 h-12 border-b bg-background/85 backdrop-blur supports-backdrop-filter:bg-background/70 select-none">
      <div className="flex h-full items-center justify-between px-3">
        <SidebarTrigger className="md:hidden" />
        <div className="ml-2 flex min-w-0 items-center gap-3.5 md:ml-0">
          <img
            src={codexShellLogoUrl}
            alt="CoCodex"
            width={27}
            height={27}
            className="shrink-0"
          />
          <div className="hidden min-w-0 items-center gap-3.5 md:flex">
            <p className="shrink-0 text-base font-semibold">CoCodex</p>
            <span className="text-base font-bold text-foreground/70">|</span>
            <p className="truncate text-base font-semibold">
              {active?.label ?? "CoCodex"}
            </p>
          </div>
        </div>

        <div className="ml-auto flex h-full items-center">
          <ThemeToggler
            theme={theme}
            resolvedTheme={resolvedTheme}
            setTheme={setTheme}
            direction="ltr"
          >
            {({ effective, toggleTheme }) => {
              const next =
                effective === "dark"
                  ? "light"
                  : effective === "light"
                    ? "system"
                    : "dark";
              return (
                <Tooltip content="切换主题" side="bottom" className="h-full">
                  <button
                    type="button"
                    onClick={() => toggleTheme(next)}
                    className="inline-flex h-full cursor-pointer items-center px-3 transition-colors hover:bg-muted"
                    aria-label="切换主题"
                  >
                    {effective === "system" ? (
                      <Monitor className="h-4 w-4" />
                    ) : effective === "dark" ? (
                      <Moon className="h-4 w-4" />
                    ) : (
                      <Sun className="h-4 w-4" />
                    )}
                  </button>
                </Tooltip>
              );
            }}
          </ThemeToggler>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="-mr-2 inline-flex h-full items-center gap-2 px-3 transition-colors hover:bg-muted data-[state=open]:bg-muted"
              >
                <span className="hidden max-w-44 truncate text-sm font-medium sm:inline">
                  {user?.username}
                </span>
                <Avatar size="sm">
                  <AvatarFallback
                    className="text-[11px] font-semibold text-white"
                    style={{ backgroundColor: color }}
                  >
                    {initial}
                  </AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem disabled>
                <Check className="h-4 w-4" />
                {user?.role === "admin" ? "管理员" : "用户"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  void logout().finally(() =>
                    navigate("/login", { replace: true }),
                  );
                }}
              >
                <LogOut className="h-4 w-4" />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}

function AppNav({
  items,
  pathname,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  onNavigate: () => void;
}) {
  const { open } = useSidebar();

  return (
    <Sidebar
      collapsible="icon"
      variant="sidebar"
      className="top-12 h-[calc(100svh-3rem)] select-none"
    >
      <SidebarContent>
        {(["workspace", "management"] as const).map((section) => {
          const sectionItems = items.filter((item) => item.section === section);
          if (sectionItems.length === 0) return null;
          return (
            <SidebarGroup
              key={section}
              className={section === "management" ? "mt-3" : undefined}
            >
              {open ? (
                <div className="px-2 py-1.5 text-[11px] text-muted-foreground/85">
                  {section === "workspace" ? "工作区" : "管理中心"}
                </div>
              ) : null}
              <SidebarMenu className="space-y-2">
                {sectionItems.map((item) => {
                  const active =
                    pathname === item.href ||
                    pathname.startsWith(`${item.href}/`);
                  const Icon = item.icon;
                  return (
                    <SidebarMenuItem key={item.href}>
                      <Tooltip
                        content={open ? undefined : item.label}
                        side="right"
                        className="w-full"
                      >
                        <NavLink
                          to={item.href}
                          onClick={() => {
                            if (!active) onNavigate();
                          }}
                          className={cn(
                            "flex h-9 w-full items-center rounded-md text-sm transition-colors",
                            open
                              ? "justify-start gap-2 px-2"
                              : "justify-center px-0",
                            active
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                          {open ? (
                            <span className="whitespace-nowrap">
                              {item.label}
                            </span>
                          ) : null}
                        </NavLink>
                      </Tooltip>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

function getAvatarColor(input: string) {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) % 360;
  }
  return `hsl(${hash} 68% 45%)`;
}
