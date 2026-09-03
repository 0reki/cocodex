import {
  CheckCircle2,
  Database,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { useOutletContext } from "react-router";

import codexShellLogoUrl from "@/assets/codex-shell-logo.svg";
import { InlineNotice } from "@/components/ui";
import {
  PORTAL_PASSWORD_MAX_LENGTH,
  PORTAL_PASSWORD_MIN_LENGTH,
} from "@/lib/auth";
import { completeSetup, type SetupStatus } from "@/lib/setup";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";

function SetupBackground() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(145deg,#f4f2ff_0%,#eef7ff_48%,#f7f4ef_100%)] dark:bg-[linear-gradient(145deg,#171622_0%,#111820_48%,#191714_100%)]" />
      <div className="aurora-flow" />
      <div className="aurora-band aurora-band-a" />
      <div className="aurora-band aurora-band-b" />
      <div className="aurora-band aurora-band-c" />
      <div className="absolute inset-0 bg-background/28 backdrop-blur-3xl" />
    </div>
  );
}

export function SetupPage() {
  const status = useOutletContext<SetupStatus>();
  const needsDatabaseUrl = !status.databaseConfigured;
  const databaseUnavailable =
    status.databaseConfigured && !status.databaseReachable;
  const [databaseUrl, setDatabaseUrl] = useState("");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password !== passwordConfirmation) {
      setError("两次输入的管理员密码不一致");
      return;
    }

    setSubmitting(true);
    try {
      const result = await completeSetup({
        ...(needsDatabaseUrl ? { databaseUrl: databaseUrl.trim() } : {}),
        adminUsername: username.trim(),
        adminPassword: password,
      });
      window.location.replace(result.redirectTo || "/login");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "初始化失败");
      setSubmitting(false);
    }
  }

  return (
    <main className="relative min-h-dvh overflow-hidden px-4 py-8 sm:px-6">
      <SetupBackground />
      <section className="relative mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-xl flex-col justify-center gap-5">
        <div className="flex items-center justify-center gap-2 text-lg font-medium select-none">
          <img
            src={codexShellLogoUrl}
            alt="CoCodex"
            width={24}
            height={24}
            className="rounded-sm"
          />
          <span>CoCodex</span>
        </div>

        <div className="overflow-hidden rounded-2xl border bg-background/88 shadow-xl shadow-black/5 backdrop-blur-xl">
          <header className="space-y-2 border-b px-5 py-5 sm:px-7">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <ShieldCheck className="size-5" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">设置 CoCodex</h1>
            <p className="text-sm text-muted-foreground">
              连接 PostgreSQL 并创建第一个管理员账号。
            </p>
          </header>

          <form
            className="grid gap-5 px-5 py-5 sm:px-7"
            onSubmit={(event) => void submit(event)}
          >
            {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}

            {needsDatabaseUrl ? (
              <label className="grid gap-1.5 text-sm font-medium">
                <span className="inline-flex items-center gap-2">
                  <Database className="size-4 text-muted-foreground" />
                  PostgreSQL 地址
                </span>
                <Input
                  value={databaseUrl}
                  onChange={(event) => setDatabaseUrl(event.target.value)}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="postgresql://user:password@host:5432/cocodex"
                  className="h-10 font-mono text-xs"
                  autoFocus
                  required
                />
              </label>
            ) : databaseUnavailable ? (
              <InlineNotice tone="error">
                部署环境中的 PostgreSQL 地址当前无法连接。请修正后端的
                DATABASE_URL，然后重新检查。
              </InlineNotice>
            ) : (
              <div className="flex items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2.5">
                <CheckCircle2 className="size-4 text-emerald-600" />
                <div className="grid gap-0.5">
                  <span className="text-sm font-medium">PostgreSQL 已连接</span>
                  <span className="text-xs text-muted-foreground">
                    将使用部署环境中已有的数据库配置。
                  </span>
                </div>
              </div>
            )}

            <label className="grid gap-1.5 text-sm font-medium">
              <span>管理员用户名</span>
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                maxLength={80}
                autoFocus={!needsDatabaseUrl}
                required
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium">
                <span>管理员密码</span>
                <Input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  minLength={PORTAL_PASSWORD_MIN_LENGTH}
                  maxLength={PORTAL_PASSWORD_MAX_LENGTH}
                  required
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                <span>确认密码</span>
                <Input
                  value={passwordConfirmation}
                  onChange={(event) =>
                    setPasswordConfirmation(event.target.value)
                  }
                  type="password"
                  autoComplete="new-password"
                  minLength={PORTAL_PASSWORD_MIN_LENGTH}
                  maxLength={PORTAL_PASSWORD_MAX_LENGTH}
                  required
                />
              </label>
            </div>

            {databaseUnavailable ? (
              <Button
                type="button"
                size="lg"
                variant="outline"
                onClick={() => window.location.reload()}
              >
                重新检查数据库
              </Button>
            ) : (
              <Button type="submit" size="lg" disabled={submitting}>
                {submitting ? <LoaderCircle className="animate-spin" /> : null}
                {submitting ? "正在初始化" : "完成设置"}
              </Button>
            )}

            <div className="grid gap-1 text-xs text-muted-foreground">
              <p>JWT Secret 将由后端自动生成并安全保存。</p>
              <p>OpenAI 上游账号可以登录后再配置。</p>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
