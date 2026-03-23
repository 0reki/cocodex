"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { memo, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import {
  Boxes,
  CreditCard,
  Check,
  ChevronDown,
  Gauge,
  Activity,
  KeyRound,
  ListTodo,
  LogOut,
  Monitor,
  Moon,
  SquareUserRound,
  UserRound,
  Sun,
  Logs,
  Router,
  Settings,
  Users,
} from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@workspace/ui/components/avatar";
import {
  ThemeToggler,
  type Resolved,
  type ThemeSelection,
} from "@workspace/ui/components/animate-ui/primitives/effects/theme-toggler";
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
} from "@workspace/ui/components/sidebar";
import { Spinner } from "@workspace/ui/components/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { useLocale } from "@/components/providers/locale-provider";
import { PortalInboxMenu } from "@/features/inbox/components/portal-inbox-menu";
import type { LocaleKey, AppLocale } from "@/locales";
import { cn } from "@workspace/ui/lib/utils";

type AppShellProps = {
  children: React.ReactNode;
};

type SessionUser = {
  id: string;
  username: string;
  avatarUrl: string | null;
  role: "admin" | "user";
  mustSetup: boolean;
};

const navItems: Array<{
  href: string;
  labelKey: LocaleKey;
  icon: React.ComponentType<{ className?: string }>;
  section: "workspace" | "management";
  adminOnly?: boolean;
}> = [
    { href: "/dashboard", labelKey: "nav.dashboard", icon: Gauge, section: "workspace" },
    {
      href: "/models",
      labelKey: "nav.models",
      icon: Boxes,
      section: "workspace",
    },
    {
      href: "/accounts",
      labelKey: "nav.accounts",
      icon: UserRound,
      section: "workspace",
    },
    {
      href: "/billing",
      labelKey: "nav.billing",
      icon: CreditCard,
      section: "workspace",
    },
    {
      href: "/tasks",
      labelKey: "nav.signup",
      icon: ListTodo,
      section: "management",
      adminOnly: true,
    },
    {
      href: "/team",
      labelKey: "nav.team",
      icon: SquareUserRound,
      section: "management",
      adminOnly: true,
    },
    {
      href: "/proxies",
      labelKey: "nav.proxies",
      icon: Router,
      section: "management",
      adminOnly: true,
    },
    { href: "/logs", labelKey: "nav.logs", icon: Logs, section: "workspace" },
    {
      href: "/keys",
      labelKey: "nav.apiKeys",
      icon: KeyRound,
      section: "workspace",
    },
    {
      href: "/settings",
      labelKey: "nav.settings",
      icon: Settings,
      section: "management",
      adminOnly: true,
    },
    {
      href: "/users",
      labelKey: "nav.userManagement",
      icon: Users,
      section: "management",
      adminOnly: true,
    },
  ];

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [isAuthed, setIsAuthed] = useState<boolean>(false);
  const [role, setRole] = useState<"admin" | "user" | null>(null);
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [authResolved, setAuthResolved] = useState<boolean>(false);
  const [isNavigating, setIsNavigating] = useState(false);
  const lastPathRef = useRef(pathname);
  const isPublicPage =
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/status";
  const isBarePublicPage = pathname === "/" || pathname === "/login";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/session", { cache: "no-store" });
        const data = (await res.json()) as {
          authed?: boolean;
          user?: {
            id?: string;
            username?: string;
            avatarUrl?: string | null;
            role?: "admin" | "user";
            mustSetup?: boolean;
          } | null;
        };
        if (!cancelled) {
          setIsAuthed(Boolean(data.authed));
          setRole(data.user?.role ?? null);
          if (data.user?.id && data.user?.username && data.user?.role) {
            setSessionUser({
              id: data.user.id,
              username: data.user.username,
              avatarUrl: data.user.avatarUrl ?? null,
              role: data.user.role,
              mustSetup: Boolean(data.user.mustSetup),
            });
          } else {
            setSessionUser(null);
          }
        }
      } catch {
        if (!cancelled) {
          setIsAuthed(false);
          setRole(null);
          setSessionUser(null);
        }
      } finally {
        if (!cancelled) {
          setAuthResolved(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    if (!authResolved || isPublicPage || isAuthed) return;
    router.replace(`/login?next=${encodeURIComponent(pathname || "/")}`);
  }, [authResolved, isAuthed, isPublicPage, pathname, router]);

  useEffect(() => {
    if (lastPathRef.current !== pathname) {
      setIsNavigating(false);
      lastPathRef.current = pathname;
    }
  }, [pathname]);

  if (!authResolved) {
    return <>{children}</>;
  }

  if (isBarePublicPage) {
    return <>{children}</>;
  }

  if (!isAuthed && !isPublicPage) {
    return <>{children}</>;
  }

  const visibleNavItems = isAuthed
    ? navItems.filter((item) => (item.adminOnly ? role === "admin" : true))
    : [];

  const handleNavigateStart = (href: string) => {
    if (!href.startsWith("/") || href === pathname) return;
    setIsNavigating(true);
  };

  return (
    <SidebarProvider defaultOpen className="h-svh overflow-hidden">
      <AppShellContent
        visibleNavItems={visibleNavItems}
        pathname={pathname}
        user={sessionUser}
        isNavigating={isNavigating}
        onNavigateStart={handleNavigateStart}
      >
        {children}
      </AppShellContent>
    </SidebarProvider>
  );
}

function AppShellContent({
  visibleNavItems,
  pathname,
  user,
  isNavigating,
  onNavigateStart,
  children,
}: {
  visibleNavItems: typeof navItems;
  pathname: string;
  user: SessionUser | null;
  isNavigating: boolean;
  onNavigateStart: (href: string) => void;
  children: React.ReactNode;
}) {
  const { t } = useLocale();
  const activeItem =
    visibleNavItems.find((item) => item.href === pathname) ??
    visibleNavItems.find(
      (item) => item.href !== "/" && pathname.startsWith(`${item.href}/`),
    ) ??
    visibleNavItems.find((item) => item.href === "/");
  const pageTitle =
    pathname === "/status"
      ? t("page.status")
      : pathname === "/inbox"
        ? t("page.inbox")
        : activeItem
          ? t(activeItem.labelKey)
          : "CoCodex";
  const setupLocked = Boolean(user?.mustSetup);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col pt-12">
      <TopNavbar
        pageTitle={pageTitle}
        user={user}
        onNavigateStart={onNavigateStart}
        setupLocked={setupLocked}
      />
      <div className="flex min-h-0 w-full min-w-0 flex-1">
        <AppNav
          visibleNavItems={visibleNavItems}
          pathname={pathname}
          onNavigateStart={onNavigateStart}
          setupLocked={setupLocked}
        />
        <AppMain isNavigating={isNavigating}>{children}</AppMain>
      </div>
    </div>
  );
}

function TopNavbar({
  pageTitle,
  user,
  onNavigateStart,
  setupLocked,
}: {
  pageTitle: string;
  user: SessionUser | null;
  onNavigateStart: (href: string) => void;
  setupLocked: boolean;
}) {
  const { locale, setLocale, t } = useLocale();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const localeItems: Array<{
    value: AppLocale;
    flagClass: string;
    label: string;
  }> = [
      { value: "en-US", flagClass: "fi fi-us", label: "English" },
      { value: "zh-CN", flagClass: "fi fi-cn", label: "简体中文" },
      { value: "zh-HK", flagClass: "fi fi-hk", label: "繁體中文（香港）" },
      { value: "zh-MO", flagClass: "fi fi-mo", label: "繁體中文（澳門）" },
      { value: "zh-TW", flagClass: "fi fi-tw", label: "繁體中文（台灣）" },
      { value: "ja-JP", flagClass: "fi fi-jp", label: "日本語" },
      { value: "es-ES", flagClass: "fi fi-es", label: "Español" },
      { value: "fr-FR", flagClass: "fi fi-fr", label: "Français" },
      { value: "de-DE", flagClass: "fi fi-de", label: "Deutsch" },
      { value: "ko-KR", flagClass: "fi fi-kr", label: "한국어" },
      { value: "pt-BR", flagClass: "fi fi-br", label: "Português (Brasil)" },
      { value: "it-IT", flagClass: "fi fi-it", label: "Italiano" },
      { value: "ru-RU", flagClass: "fi fi-ru", label: "Русский" },
      { value: "tr-TR", flagClass: "fi fi-tr", label: "Türkçe" },
    ];
  const currentLocale =
    localeItems.find((item) => item.value === locale) ?? localeItems[0]!;
  const displayInitial = user?.username?.slice(0, 1).toUpperCase() ?? "?";
  const fallbackBg = getAvatarFallbackColor(user?.username ?? "");
  const setupLockedHint = t("setup.completeProfileHint");
  return (
    <header className="fixed inset-x-0 top-0 z-30 h-12 w-full shrink-0 border-b bg-background/85 backdrop-blur supports-backdrop-filter:bg-background/70 select-none">
      <div className="relative flex h-full items-center justify-between px-3">
        <SidebarTrigger className="md:hidden" />
        <div className="ml-2 flex min-w-0 items-center gap-3.5 md:ml-0">
          <Image
            src="/codex-shell-logo.svg"
            alt="Codex Logo"
            width={27}
            height={27}
            className="shrink-0"
          />
          <div className="hidden min-w-0 items-center gap-3.5 md:flex">
            <p className="shrink-0 text-base font-semibold">CoCodex</p>
            <span className="shrink-0 text-base font-bold text-foreground/70">
              |
            </span>
            <p className="truncate text-base font-semibold">{pageTitle}</p>
          </div>
        </div>
        <div className="ml-auto flex h-full items-center">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="group/lang inline-flex h-full cursor-pointer items-center gap-2 px-2 transition-colors hover:bg-muted data-[state=open]:bg-muted sm:px-3"
                aria-label={t("lang.switch")}
                title={t("lang.switch")}
              >
                <span
                  className={cn(
                    currentLocale.flagClass,
                    "inline-block h-3 w-4 shrink-0 overflow-hidden rounded-[3px]",
                  )}
                />
                <span className="hidden text-sm sm:inline">{currentLocale.label}</span>
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]/lang:rotate-180" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {localeItems.map((item) => (
                <DropdownMenuItem
                  key={item.value}
                  onSelect={() => setLocale(item.value)}
                >
                  <span className="flex w-full items-center justify-between">
                    <span className="flex items-center gap-2 text-sm">
                      <span
                        className={cn(
                          item.flagClass,
                          "inline-block h-3 w-4 shrink-0 overflow-hidden rounded-[3px]",
                        )}
                      />
                      <span>{item.label}</span>
                    </span>
                    {locale === item.value ? (
                      <Check className="h-4 w-4" />
                    ) : null}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <ThemeToggler
            theme={(theme ?? "system") as ThemeSelection}
            resolvedTheme={(resolvedTheme ?? "light") as Resolved}
            setTheme={setTheme}
            direction="ltr"
          >
            {({ effective, toggleTheme }) => {
              const nextTheme =
                effective === "dark"
                  ? "light"
                  : effective === "system"
                    ? "dark"
                    : "system";
              return (
                <button
                  type="button"
                  onClick={() => toggleTheme(nextTheme)}
                  className="inline-flex h-full cursor-pointer items-center px-2 transition-colors hover:bg-muted sm:px-3"
                  aria-label={t("theme.switch")}
                  title={t("theme.switch")}
                >
                  {effective === "system" ? (
                    <Monitor className="h-4 w-4" />
                  ) : effective === "dark" ? (
                    <Moon className="h-4 w-4" />
                  ) : (
                    <Sun className="h-4 w-4" />
                  )}
                </button>
              );
            }}
          </ThemeToggler>
          {user ? (
            <PortalInboxMenu onNavigateStart={onNavigateStart} />
          ) : null}
          {user ? (
            <Link
              href={setupLocked ? "#" : "/status"}
              onClick={(event) => {
                if (setupLocked) {
                  event.preventDefault();
                  return;
                }
                onNavigateStart("/status");
              }}
              className={cn(
                "inline-flex h-full cursor-pointer items-center px-2 transition-colors hover:bg-muted sm:px-3",
                setupLocked && "cursor-not-allowed opacity-45 hover:bg-transparent",
                pageTitle === t("page.status") ? "bg-muted" : "",
              )}
              aria-label={setupLocked ? setupLockedHint : t("page.status")}
              title={setupLocked ? setupLockedHint : t("page.status")}
              aria-disabled={setupLocked}
              tabIndex={setupLocked ? -1 : undefined}
            >
              <Activity className="h-4 w-4" />
            </Link>
          ) : null}
          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="-mr-2 inline-flex h-full shrink-0 cursor-pointer items-center gap-1 px-2 transition-colors hover:bg-muted data-[state=open]:bg-muted select-none sm:-mr-3 sm:gap-2 sm:px-3"
                  aria-label={`Current user: ${user.username}`}
                >
                  <span className="hidden max-w-44 truncate text-sm font-medium text-foreground sm:inline">
                    {user.username}
                  </span>
                  <Avatar size="sm">
                    {user.avatarUrl ? (
                      <AvatarImage src={user.avatarUrl} alt={user.username} />
                    ) : null}
                    <AvatarFallback
                      className="text-[11px] font-semibold text-white"
                      style={{ backgroundColor: fallbackBg }}
                    >
                      {displayInitial}
                    </AvatarFallback>
                  </Avatar>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem disabled>{user.username}</DropdownMenuItem>
                <DropdownMenuSeparator />
                {setupLocked ? (
                  <DropdownMenuItem
                    disabled
                    title={setupLockedHint}
                    className="flex items-center gap-2"
                  >
                    <SquareUserRound className="h-4 w-4 shrink-0" />
                    <span>{t("page.profile")}</span>
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem asChild>
                    <Link
                      href="/profile"
                      onClick={() => onNavigateStart("/profile")}
                      className="flex items-center gap-2"
                    >
                      <SquareUserRound className="h-4 w-4 shrink-0" />
                      <span>{t("page.profile")}</span>
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    void (async () => {
                      try {
                        await fetch("/api/admin/logout", {
                          method: "POST",
                          cache: "no-store",
                        });
                      } finally {
                        window.location.assign("/login");
                      }
                    })();
                  }}
                >
                  <LogOut className="h-4 w-4 shrink-0" />
                  <span>{t("nav.logout")}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Link
              href="/login"
              onClick={() => onNavigateStart("/login")}
              className="-mr-3 inline-flex h-full shrink-0 cursor-pointer items-center px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              aria-label={t("login.signIn")}
            >
              {t("login.signIn")}
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

function getAvatarFallbackColor(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) % 360;
  }
  return `hsl(${hash} 68% 45%)`;
}

function AppNav({
  visibleNavItems,
  pathname,
  onNavigateStart,
  setupLocked,
}: {
  visibleNavItems: typeof navItems;
  pathname: string;
  onNavigateStart: (href: string) => void;
  setupLocked: boolean;
}) {
  const { t } = useLocale();
  const { open } = useSidebar();
  const setupLockedHint = t("setup.completeProfileHint");
  const workspaceItems = visibleNavItems.filter(
    (item) => item.section === "workspace",
  );
  const managementItems = visibleNavItems.filter(
    (item) => item.section === "management",
  );

  return (
    <Sidebar
      collapsible="icon"
      variant="sidebar"
      className="top-12 h-[calc(100svh-3rem)] select-none"
    >
      <SidebarContent>
        {workspaceItems.length > 0 ? (
          <SidebarGroup>
            {open ? (
              <div className="px-2 py-1.5 text-[11px] font-normal tracking-normal text-muted-foreground/85">
                {t("nav.workspace")}
              </div>
            ) : null}
            <SidebarMenu className="space-y-2">
              {workspaceItems.map((item) => {
                const active = pathname === item.href;
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.href}>
                    <Link
                      href={item.href}
                      onClick={(event) => {
                        if (setupLocked) {
                          event.preventDefault();
                          return;
                        }
                        onNavigateStart(item.href);
                      }}
                      data-slot="sidebar-menu-link"
                      aria-disabled={setupLocked}
                      tabIndex={setupLocked ? -1 : undefined}
                      title={setupLocked ? setupLockedHint : undefined}
                      className={cn(
                        "flex h-9 items-center rounded-md text-sm transition-colors",
                        open
                          ? "justify-start gap-2 px-2"
                          : "justify-center px-0",
                        setupLocked && "cursor-not-allowed opacity-45 hover:bg-transparent",
                        active
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {open ? (
                        <span className="whitespace-nowrap">
                          {t(item.labelKey)}
                        </span>
                      ) : null}
                    </Link>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ) : null}
        {managementItems.length > 0 ? (
          <SidebarGroup className="mt-3">
            {open ? (
              <div className="px-2 py-1.5 text-[11px] font-normal tracking-normal text-muted-foreground/85">
                {t("nav.managementCenter")}
              </div>
            ) : null}
            <SidebarMenu className="space-y-2">
              {managementItems.map((item) => {
                const active = pathname === item.href;
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.href}>
                    <Link
                      href={item.href}
                      onClick={(event) => {
                        if (setupLocked) {
                          event.preventDefault();
                          return;
                        }
                        onNavigateStart(item.href);
                      }}
                      data-slot="sidebar-menu-link"
                      aria-disabled={setupLocked}
                      tabIndex={setupLocked ? -1 : undefined}
                      title={setupLocked ? setupLockedHint : undefined}
                      className={cn(
                        "flex h-9 items-center rounded-md text-sm transition-colors",
                        open
                          ? "justify-start gap-2 px-2"
                          : "justify-center px-0",
                        setupLocked && "cursor-not-allowed opacity-45 hover:bg-transparent",
                        active
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {open ? (
                        <span className="whitespace-nowrap">
                          {t(item.labelKey)}
                        </span>
                      ) : null}
                    </Link>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ) : null}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

const AppMain = memo(function AppMain({
  isNavigating,
  children,
}: {
  isNavigating: boolean;
  children: React.ReactNode;
}) {
  return (
    <SidebarInset className="min-w-0">
      <section className="relative min-h-0 flex-1 overflow-y-auto">
        {isNavigating ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/60 backdrop-blur-[1px]">
            <Spinner />
          </div>
        ) : null}
        <div className={cn(isNavigating ? "pointer-events-none opacity-60" : "")}>
          {children}
        </div>
      </section>
    </SidebarInset>
  );
});
