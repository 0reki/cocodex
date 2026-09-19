import { Spinner } from "@/ui/components/spinner";
import { ArrowUpRight, EllipsisVertical } from "lucide-react";
import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import {
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
  Modal,
  StatusPill,
} from "@/components/ui";
import { useToast } from "@/components/toast";
import { useResource } from "@/hooks/use-resource";
import { jsonBody } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatUsd, shortId } from "@/lib/format";
import type {
  OpenAIAccount,
  OpenAIAccountsResponse,
  UpstreamPlatform,
} from "@/types/api";
import { Button } from "@/ui/components/button";
import { Checkbox } from "@/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/components/dropdown-menu";
import { Input } from "@/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/table";

type UsageWindow = { usedPercent: number; resetsAt: string };

type AccountUsage = {
  ok: true;
  capturedAt: string;
  planType: string | null;
  rateLimit: {
    allowed: boolean | null;
    limitReached: boolean | null;
    primaryWindow: UsageWindow | null;
    secondaryWindow: UsageWindow | null;
  };
  today: {
    totals: { usd: number | null; textTotalTokens: number | null };
  } | null;
  totals: { credits: number; usd: number };
  weeklyEstimate: {
    available: boolean;
    observedUsd: number;
    estimatedTotalUsd: number | null;
    estimatedRemainingUsd: number | null;
  };
};

type TestResult = {
  ok: boolean;
  durationMs: number;
  upstreamStatus?: number;
  result?: unknown;
  error?: string;
};

const LOGIN_PLATFORMS: { value: UpstreamPlatform; label: string }[] = [
  { value: "windows", label: "Windows" },
  { value: "linux", label: "Linux" },
  { value: "darwin", label: "macOS" },
];

function platformLabel(platform: UpstreamPlatform): string {
  return (
    { windows: "Windows", linux: "Linux", darwin: "macOS", all: "通用" }[
      platform
    ] ?? platform
  );
}

type OAuthStart = {
  authorizeUrl: string;
  codeVerifier: string;
  state: string;
  redirectUri: string;
};

// Logs an upstream account in with the same browser OAuth flow the Codex CLI
// uses: open the authorization URL, sign in, then paste back the redirect the
// browser lands on. The login is bound to the chosen platform, since each OS
// is a separate upstream login.
function AccountOAuthLogin({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useAuth();
  const [platform, setPlatform] = useState<UpstreamPlatform>("windows");
  const [flow, setFlow] = useState<OAuthStart | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api<OAuthStart>("/api/openai-accounts/oauth/start", {
        method: "POST",
        ...jsonBody({ platform }),
      });
      setFlow(next);
      window.open(next.authorizeUrl, "_blank", "noopener,noreferrer");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法启动 OAuth 登录");
    } finally {
      setBusy(false);
    }
  }, [api, platform]);

  const finish = useCallback(async () => {
    if (!flow || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/openai-accounts/oauth/exchange", {
        method: "POST",
        ...jsonBody({
          code: code.trim(),
          codeVerifier: flow.codeVerifier,
          state: flow.state,
          redirectUri: flow.redirectUri,
          platform,
        }),
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "OAuth 登录失败");
    } finally {
      setBusy(false);
    }
  }, [api, code, flow, onSaved, platform]);

  if (flow) {
    return (
      <div className="grid gap-4">
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
        <p className="text-sm text-muted-foreground">
          已在新标签页打开 OpenAI 授权页（平台：{platformLabel(platform)}）。登录后浏览器会跳转到
          {" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            {flow.redirectUri}
          </code>{" "}
          （页面打不开是正常的），把地址栏里的完整链接或其中的 code 粘贴到下面。
        </p>
        <a
          href={flow.authorizeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
        >
          重新打开授权页
          <ArrowUpRight className="size-3.5" />
        </a>
        <Input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="粘贴回调链接或 code"
          aria-label="回调链接或 code"
        />
        <footer className="flex justify-end gap-2 pt-4">
          <Button variant="outline" type="button" onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            disabled={busy || !code.trim()}
            onClick={() => void finish()}
          >
            {busy ? (
              <>
                <Spinner />
                <span className="sr-only">处理中</span>
              </>
            ) : (
              "完成登录"
            )}
          </Button>
        </footer>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      <p className="text-sm text-muted-foreground">
        走与 Codex 一致的浏览器 OAuth 登录添加账号。请先选择该账号服务的系统平台。
      </p>
      <label className="grid gap-1.5 text-sm">
        <span className="text-muted-foreground">平台</span>
        <Select
          value={platform}
          onValueChange={(value) => setPlatform(value as UpstreamPlatform)}
        >
          <SelectTrigger aria-label="平台">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOGIN_PLATFORMS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <footer className="flex justify-end gap-2 pt-4">
        <Button variant="outline" type="button" onClick={onClose}>
          取消
        </Button>
        <Button type="button" disabled={busy} onClick={() => void start()}>
          {busy ? (
            <>
              <Spinner />
              <span className="sr-only">处理中</span>
            </>
          ) : (
            "打开授权页"
          )}
        </Button>
      </footer>
    </div>
  );
}

function UsageDetails({ usage }: { usage: AccountUsage }) {
  const windows = [
    ["主窗口", usage.rateLimit.primaryWindow],
    ["次窗口", usage.rateLimit.secondaryWindow],
  ] as const;

  return (
    <div className="grid gap-4">
      <dl className="grid gap-3 border-b pb-4 sm:grid-cols-3">
        {[
          ["套餐", usage.planType ?? "—"],
          ["累计费用", formatUsd(usage.totals.usd)],
          ["预估周剩余", formatUsd(usage.weeklyEstimate.estimatedRemainingUsd)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      {windows.map(([label, window]) =>
        window ? (
          <div className="grid gap-2" key={label}>
            <div className="flex justify-between text-sm">
              <span>{label}</span>
              <strong>{window.usedPercent.toFixed(1)}%</strong>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.min(100, window.usedPercent)}%` }}
              />
            </div>
            <div className="text-xs text-muted-foreground">
              重置于 {formatDate(window.resetsAt)}
            </div>
          </div>
        ) : null,
      )}
    </div>
  );
}

export function AccountsPage() {
  const { api } = useAuth();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(
    () => new Set(),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    title: string;
    content: ReactNode;
  } | null>(null);

  const load = useCallback(
    (signal: AbortSignal) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: "25",
      });
      if (status) params.set("status", status);
      if (query) params.set("q", query);
      return api<OpenAIAccountsResponse>(`/api/openai-accounts?${params}`, {
        signal,
      });
    },
    [api, page, query, status],
  );
  const { data, error, loading, reload } = useResource(load);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setQuery(searchDraft.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  async function mutate(
    item: OpenAIAccount,
    action: "activate" | "disable" | "delete",
  ) {
    if (action === "delete" && !window.confirm(`确定删除 ${item.email} 吗？`)) {
      return;
    }
    setBusy(item.id);
    setActionError(null);
    try {
      const path = `/api/openai-accounts/${encodeURIComponent(item.email)}${action === "delete" ? "" : `/${action}`}`;
      await api(path, { method: action === "delete" ? "DELETE" : "POST" });
      await reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  async function inspect(item: OpenAIAccount, mode: "usage" | "test") {
    setBusy(item.id);
    setActionError(null);
    try {
      if (mode === "usage") {
        const usage = await api<AccountUsage>(
          `/api/openai-accounts/${encodeURIComponent(item.email)}/usage`,
        );
        setDetail({
          title: `${item.email} · 用量`,
          content: <UsageDetails usage={usage} />,
        });
      } else {
        const result = await api<TestResult>(
          `/api/openai-accounts/${encodeURIComponent(item.email)}/test`,
          { method: "POST", ...jsonBody({ text: "test" }) },
        );
        const notify = result.ok ? toast.success : toast.error;
        notify({
          title: `${item.email} · 连通测试`,
          description: result.ok
            ? `连接正常 · ${result.durationMs} ms`
            : (result.error ?? "测试失败"),
          detail:
            typeof result.result === "string" && result.result.trim()
              ? JSON.stringify(result.result.trim())
              : undefined,
        });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "请求失败";
      if (mode === "test") {
        toast.error({
          title: `${item.email} · 连通测试`,
          description: message,
        });
      } else {
        setActionError(message);
      }
    } finally {
      setBusy(null);
    }
  }

  async function bulkMutate(action: "disable" | "remove") {
    const emails = [...selectedEmails];
    if (!emails.length) return;
    const verb = action === "remove" ? "删除" : "停用";
    if (!window.confirm(`确定${verb}已选中的 ${emails.length} 个账号吗？`)) {
      return;
    }
    setBusy("bulk");
    setActionError(null);
    try {
      await api(`/api/openai-accounts/bulk-${action}`, {
        method: "POST",
        ...jsonBody({ emails }),
      });
      setSelectedEmails(new Set());
      await reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "批量操作失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="flex w-full flex-col gap-6 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
      <section>
        <h1 className="text-2xl font-bold">OpenAI 账号</h1>
      </section>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center lg:flex-1">
          <Input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="邮箱或 Account ID"
            aria-label="搜索账号"
            className="h-8 w-full text-sm sm:max-w-sm"
          />
          <Select
            value={status || "all"}
            onValueChange={(value) => {
              setStatus(value === "all" ? "" : value);
              setPage(1);
            }}
          >
            <SelectTrigger
              className="h-8 w-full text-sm sm:w-40"
              aria-label="账号状态"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="active">使用中</SelectItem>
              <SelectItem value="inactive">待用</SelectItem>
              <SelectItem value="disabled">已停用</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:justify-end">
          <Button variant="outline" type="button" onClick={() => void reload()}>
            刷新
          </Button>
          <Button type="button" onClick={() => setAdding(true)}>
            添加账号
          </Button>
          <Button
            variant="outline"
            type="button"
            disabled={!selectedEmails.size || busy === "bulk"}
            onClick={() => void bulkMutate("disable")}
          >
            批量停用
          </Button>
          <Button
            variant="destructive"
            type="button"
            disabled={!selectedEmails.size || busy === "bulk"}
            onClick={() => void bulkMutate("remove")}
          >
            删除{selectedEmails.size ? ` (${selectedEmails.size})` : ""}
          </Button>
        </div>
      </div>

      {actionError ? (
        <InlineNotice tone="error">{actionError}</InlineNotice>
      ) : null}
      {error && !data ? (
        <ErrorState message={error} retry={() => void reload()} />
      ) : null}
      {loading && !data ? <LoadingState label="正在读取账号" /> : null}

      {data ? (
        <>
          <section className="overflow-x-auto rounded-2xl border">
            {data.items.length ? (
              <Table className="min-w-220">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={
                          data.items.every((item) =>
                            selectedEmails.has(item.email),
                          )
                            ? true
                            : data.items.some((item) =>
                                  selectedEmails.has(item.email),
                                )
                              ? "indeterminate"
                              : false
                        }
                        onCheckedChange={(checked) => {
                          setSelectedEmails((current) => {
                            const next = new Set(current);
                            for (const item of data.items) {
                              if (checked) next.add(item.email);
                              else next.delete(item.email);
                            }
                            return next;
                          });
                        }}
                        aria-label="选择本页账号"
                      />
                    </TableHead>
                    <TableHead>账号</TableHead>
                    <TableHead>Account ID</TableHead>
                    <TableHead>平台</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>更新时间</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <Checkbox
                          checked={selectedEmails.has(item.email)}
                          onCheckedChange={(checked) => {
                            setSelectedEmails((current) => {
                              const next = new Set(current);
                              if (checked) next.add(item.email);
                              else next.delete(item.email);
                              return next;
                            });
                          }}
                          aria-label={`选择 ${item.email}`}
                        />
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">{item.email}</span>
                      </TableCell>
                      <TableCell>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {shortId(item.accountId)}
                        </code>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {platformLabel(item.platform)}
                      </TableCell>
                      <TableCell>
                        <StatusPill value={item.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(item.updatedAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="outline"
                                size="icon"
                                disabled={busy === item.id}
                                aria-label={`管理 ${item.email}`}
                              >
                                <EllipsisVertical />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                              <DropdownMenuItem
                                onSelect={() => void inspect(item, "usage")}
                              >
                                查看用量
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => void inspect(item, "test")}
                              >
                                测试连接
                              </DropdownMenuItem>
                              {item.status !== "active" ? (
                                <DropdownMenuItem
                                  onSelect={() => void mutate(item, "activate")}
                                >
                                  设为使用中
                                </DropdownMenuItem>
                              ) : null}
                              {item.status !== "disabled" ? (
                                <DropdownMenuItem
                                  onSelect={() => void mutate(item, "disable")}
                                >
                                  停用
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => void mutate(item, "delete")}
                              >
                                删除
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState />
            )}
          </section>
          <section className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-sm text-muted-foreground">
              共 {data.count} 个
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                上一页
              </Button>
              <span className="min-w-16 text-center text-sm text-muted-foreground">
                {data.page} / {Math.max(1, data.totalPages)}
              </span>
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={page >= data.totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </Button>
            </div>
          </section>
        </>
      ) : null}

      {adding ? (
        <Modal wide title="添加 OpenAI 账号" onClose={() => setAdding(false)}>
          <AccountOAuthLogin
            onClose={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              void reload();
            }}
          />
        </Modal>
      ) : null}
      {detail ? (
        <Modal wide title={detail.title} onClose={() => setDetail(null)}>
          {detail.content}
        </Modal>
      ) : null}
    </main>
  );
}
