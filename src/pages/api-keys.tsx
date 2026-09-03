import { CalendarDays, LoaderCircle, Pencil, Trash } from "lucide-react";
import { useCallback, useMemo, useState, type FormEvent } from "react";

import {
  CopyButton,
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
  Modal,
  Tooltip,
} from "@/components/ui";
import { useResource } from "@/hooks/use-resource";
import { jsonBody } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatUsd } from "@/lib/format";
import type { ApiKey, ApiKeysResponse } from "@/types/api";
import { Button } from "@/ui/components/button";
import { Calendar } from "@/ui/components/calendar";
import { Input } from "@/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/components/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/table";
import { cn } from "@/ui/lib/utils";

function parseDate(value: string | null) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function KeyForm({
  item,
  onClose,
  onSaved,
}: {
  item: ApiKey | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useAuth();
  const [name, setName] = useState(item?.name ?? "");
  const [quota, setQuota] = useState(
    item?.quota == null ? "" : String(item.quota),
  );
  const [expiresAt, setExpiresAt] = useState<Date | undefined>(() =>
    parseDate(item?.expiresAt ?? null),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const quotaValue = quota.trim() ? Number(quota) : null;
    if (
      quotaValue !== null &&
      (!Number.isFinite(quotaValue) || quotaValue < 0)
    ) {
      setError("请输入有效额度");
      return;
    }
    setSubmitting(true);
    setError(null);
    const payload = {
      name: name.trim(),
      quota: quotaValue,
      expiresAt: expiresAt?.toISOString() ?? null,
    };
    try {
      await api(item ? `/api/api-keys/${item.id}` : "/api/api-keys", {
        method: item ? "PUT" : "POST",
        ...jsonBody(payload),
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      <label className="grid gap-1.5 text-sm font-medium">
        <span>名称</span>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：本地开发"
          maxLength={80}
          autoFocus
          required
        />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1.5 text-sm font-medium">
          <span>额度</span>
          <Input
            type="text"
            inputMode="decimal"
            value={quota}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "" || /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
                setQuota(value);
              }
            }}
            placeholder="不限制"
          />
        </label>
        <div className="grid gap-1.5 text-sm font-medium">
          <span>过期时间</span>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                className={cn(
                  "w-full justify-start font-normal",
                  !expiresAt && "text-muted-foreground",
                )}
              >
                <CalendarDays />
                {expiresAt ? expiresAt.toLocaleDateString("zh-CN") : "选择日期"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={expiresAt}
                onSelect={setExpiresAt}
                defaultMonth={expiresAt}
              />
              {expiresAt ? (
                <div className="flex justify-end px-2 pb-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setExpiresAt(undefined)}
                  >
                    清除日期
                  </Button>
                </div>
              ) : null}
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <footer className="flex justify-end gap-2 pt-4">
        <Button variant="outline" type="button" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? (
            <>
              <LoaderCircle className="animate-spin" />
              <span className="sr-only">处理中</span>
            </>
          ) : (
            "继续"
          )}
        </Button>
      </footer>
    </form>
  );
}

function CodeTabs({ codes }: { codes: Record<string, string> }) {
  const names = Object.keys(codes);
  const [active, setActive] = useState(names[0] ?? "");
  const code = codes[active] ?? "";

  return (
    <div className="overflow-hidden rounded-xl border bg-background">
      <div className="flex items-center justify-between border-b bg-muted/25 px-2">
        <div className="flex min-w-0 items-center">
          {names.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setActive(name)}
              className={cn(
                "h-10 border-b-2 px-3 text-xs font-medium transition-colors",
                active === name
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {name}
            </button>
          ))}
        </div>
        <CopyButton value={code} label="复制代码" />
      </div>
      <pre className="overflow-x-auto p-4 text-xs leading-6">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function ApiDocs() {
  const baseUrl = useMemo(() => {
    const configured = import.meta.env.VITE_API_BASE_URL?.trim();
    return (configured || window.location.origin).replace(/\/+$/, "");
  }, []);
  const responsesCurl = `curl ${baseUrl}/v1/responses \\
  -H "Authorization: Bearer <YOUR_API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": "Hello!",
    "store": false,
    "stream": true
  }'`;
  const responsesTs = `const response = await fetch("${baseUrl}/v1/responses", {
  method: "POST",
  headers: {
    Authorization: "Bearer <YOUR_API_KEY>",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-5.4",
    input: "Hello!",
    store: false,
    stream: true,
  }),
});`;
  const modelsCurl = `curl ${baseUrl}/v1/models \\
  -H "Authorization: Bearer <YOUR_API_KEY>"`;
  const modelsTs = `const response = await fetch("${baseUrl}/v1/models", {
  headers: { Authorization: "Bearer <YOUR_API_KEY>" },
});

const data = await response.json();`;
  const codexConfig = `[model_providers.OpenAI]
name = "OpenAI"
base_url = "${baseUrl}/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false`;
  const codexAuth = `{
  "OPENAI_API_KEY": "<YOUR_API_KEY>"
}`;

  return (
    <section className="grid gap-4">
      <h2 className="text-lg font-semibold">API 使用方式</h2>
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="font-medium">API Endpoint:</span>
        <code className="rounded bg-muted px-1.5 py-0.5">{baseUrl}</code>
        <CopyButton value={baseUrl} />
      </div>
      <div className="grid gap-2">
        <h3 className="text-sm font-medium">Codex 配置</h3>
        <CodeTabs
          codes={{ "config.toml": codexConfig, "auth.json": codexAuth }}
        />
      </div>
      <div className="grid gap-2">
        <h3 className="text-sm font-medium">Responses API</h3>
        <CodeTabs codes={{ HTTP: responsesCurl, TypeScript: responsesTs }} />
      </div>
      <div className="grid gap-2">
        <h3 className="text-sm font-medium">模型列表</h3>
        <CodeTabs codes={{ HTTP: modelsCurl, TypeScript: modelsTs }} />
      </div>
    </section>
  );
}

export function ApiKeysPage() {
  const { api } = useAuth();
  const [editing, setEditing] = useState<ApiKey | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiKey | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const load = useCallback(
    (signal: AbortSignal) =>
      api<ApiKeysResponse>("/api/api-keys", { signal }),
    [api],
  );
  const { data, error, loading, reload } = useResource(load);

  async function deleteKey(item: ApiKey) {
    setDeleting(true);
    setActionError(null);
    try {
      await api(`/api/api-keys/${item.id}`, { method: "DELETE" });
      await reload();
      setDeleteTarget(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "移除失败");
    } finally {
      setDeleting(false);
    }
  }

  function closeAndReload() {
    setEditing(null);
    void reload();
  }

  return (
    <main className="flex w-full flex-col gap-6 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
      <section>
        <h1 className="text-2xl font-bold">API Keys</h1>
      </section>

      {actionError ? (
        <InlineNotice tone="error">{actionError}</InlineNotice>
      ) : null}
      {error && !data ? (
        <ErrorState message={error} retry={() => void reload()} />
      ) : null}
      {loading && !data ? <LoadingState label="正在读取 API Keys" /> : null}

      {data ? (
        <section className="bg-background">
          <div className="mb-3 flex items-center justify-end gap-2">
            <Button
              variant="outline"
              type="button"
              onClick={() => void reload()}
            >
              刷新
            </Button>
            <Button type="button" onClick={() => setEditing("new")}>
              新建 Key
            </Button>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            {data.items.length ? (
              <Table className="min-w-245">
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>用量 / 额度</TableHead>
                    <TableHead>过期</TableHead>
                    <TableHead>更新时间</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((item) => {
                    const usagePercent =
                      item.quota && item.quota > 0
                        ? Math.min(100, (item.used / item.quota) * 100)
                        : 0;
                    return (
                      <TableRow key={item.id}>
                        <TableCell className="font-medium">
                          {item.name}
                        </TableCell>
                        <TableCell>
                          <div className="flex max-w-72 items-center gap-1">
                            <code className="truncate rounded bg-muted px-1.5 py-0.5 text-xs">
                              {item.apiKey}
                            </code>
                            <CopyButton
                              value={item.apiKey}
                              label="复制 API Key"
                            />
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex min-w-44 flex-col gap-1">
                            <div className="text-xs text-muted-foreground">
                              {formatUsd(item.used)}
                              {item.quota == null
                                ? ""
                                : ` / ${formatUsd(item.quota)}`}
                            </div>
                            <div className="h-2 w-full rounded-full bg-muted">
                              <div
                                className="h-2 rounded-full bg-primary transition-all"
                                style={{ width: `${usagePercent}%` }}
                              />
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(item.expiresAt)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(item.updatedAt)}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Tooltip content="编辑 API Key">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                type="button"
                                onClick={() => setEditing(item)}
                                aria-label="编辑 API Key"
                              >
                                <Pencil className="size-3.5" />
                              </Button>
                            </Tooltip>
                            <Tooltip content="移除 API Key">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                type="button"
                                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => {
                                  setActionError(null);
                                  setDeleteTarget(item);
                                }}
                                aria-label="移除 API Key"
                              >
                                <Trash className="size-3.5" />
                              </Button>
                            </Tooltip>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <EmptyState />
            )}
          </div>
        </section>
      ) : null}

      <ApiDocs />

      {editing ? (
        <Modal
          title={editing === "new" ? "新建 API Key" : "编辑 API Key"}
          onClose={() => setEditing(null)}
        >
          <KeyForm
            item={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={closeAndReload}
          />
        </Modal>
      ) : null}

      {deleteTarget ? (
        <Modal
          title="移除 API Key"
          onClose={() => {
            if (!deleting) setDeleteTarget(null);
          }}
        >
          <div className="grid gap-4">
            {actionError ? (
              <InlineNotice tone="error">{actionError}</InlineNotice>
            ) : null}
            <p className="text-sm text-muted-foreground">
              确定移除“{deleteTarget.name}”吗？此操作不可逆。
            </p>
            <footer className="flex justify-end gap-2 pt-4">
              <Button
                variant="outline"
                type="button"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                type="button"
                disabled={deleting}
                onClick={() => void deleteKey(deleteTarget)}
              >
                {deleting ? (
                  <>
                    <LoaderCircle className="animate-spin" />
                    <span className="sr-only">处理中</span>
                  </>
                ) : (
                  "继续"
                )}
              </Button>
            </footer>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}
