import { format } from "date-fns";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Info,
  Zap,
} from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import type { DateRange } from "react-day-picker";

import {
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  Tooltip,
} from "@/components/ui";
import { useResource } from "@/hooks/use-resource";
import { useAuth } from "@/lib/auth";
import type {
  ApiKeysResponse,
  RequestLog,
  RequestLogsResponse,
} from "@/types/api";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Calendar } from "@/ui/components/calendar";
import { Input } from "@/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/components/popover";
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

type Filters = {
  modelId: string;
  keyId: string;
  status: string;
  dateFrom: string;
  dateTo: string;
};

const emptyFilters: Filters = {
  modelId: "",
  keyId: "",
  status: "",
  dateFrom: "",
  dateTo: "",
};

function parseDate(value: string) {
  if (!value) return undefined;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function formatDateRange(range: DateRange | undefined) {
  if (!range?.from) return "请求日期";
  if (!range.to) return format(range.from, "yyyy-MM-dd");
  return `${format(range.from, "yyyy-MM-dd")} – ${format(range.to, "yyyy-MM-dd")}`;
}

function getStatusBadge(log: RequestLog): {
  variant: "secondary" | "outline" | "destructive";
  label: string;
  className?: string;
} {
  const { statusCode } = log;
  if (statusCode === null) {
    return { variant: "outline", label: "—" };
  }
  if (statusCode >= 200 && statusCode < 300) {
    if (log.isFinal) {
      return {
        variant: "secondary",
        label: String(statusCode),
        className:
          "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
      };
    }
    if (log.streamEndReason?.startsWith("client_aborted")) {
      return {
        variant: "outline",
        label: `${statusCode} 已中止`,
        className:
          "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
      };
    }
    const failed = Boolean(log.errorCode || log.streamEndReason);
    return {
      variant: failed ? "destructive" : "outline",
      label: `${statusCode} ${failed ? "失败" : "未完成"}`,
      className: failed
        ? undefined
        : "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
    };
  }
  return { variant: "destructive", label: String(statusCode) };
}

function formatRequestTime(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? value
    : new Date(timestamp).toLocaleString("zh-CN");
}

function formatMs(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  const milliseconds = Math.max(0, value);
  if (milliseconds < 1000) return `${milliseconds} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes} m ${remainingSeconds.toFixed(1)} s`
      : `${minutes} m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `${hours} h ${remainingMinutes} m`
    : `${hours} h`;
}

function formatCost(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? "—"
    : `$${value.toFixed(6)}`;
}

function formatToken(value: unknown) {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number)
    ? new Intl.NumberFormat("zh-CN", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(number)
    : "—";
}

function getTokens(tokensInfo: Record<string, unknown> | null) {
  const details =
    tokensInfo?.input_tokens_details &&
    typeof tokensInfo.input_tokens_details === "object"
      ? (tokensInfo.input_tokens_details as Record<string, unknown>)
      : null;
  return {
    input: formatToken(tokensInfo?.input_tokens),
    cachedInput: formatToken(details?.cached_tokens),
    output: formatToken(tokensInfo?.output_tokens),
    total: formatToken(tokensInfo?.total_tokens),
  };
}

function ModelLabel({ log }: { log: RequestLog }) {
  return (
    <span className="inline-flex items-center gap-1.5 align-middle leading-none">
      {log.serviceTier === "priority" ? (
        <Tooltip content="快速模式">
          <span
            aria-label="快速模式"
            className="inline-flex size-4 items-center justify-center rounded-sm text-emerald-500"
          >
            <Zap className="size-3.5 fill-current" strokeWidth={1.75} />
          </span>
        </Tooltip>
      ) : null}
      <span className="leading-none">{log.modelId ?? "—"}</span>
    </span>
  );
}

function DetailField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <span className="text-muted-foreground">{label}：</span>
      <span className="break-all">{children}</span>
    </div>
  );
}

function LogDetails({ log }: { log: RequestLog }) {
  const status = getStatusBadge(log);
  const tokens = getTokens(log.tokensInfo);

  return (
    <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
      <DetailField label="请求时间">
        {formatRequestTime(log.requestTime)}
      </DetailField>
      <DetailField label="路径">{log.path}</DetailField>
      <DetailField label="模型">
        <ModelLabel log={log} />
      </DetailField>
      <DetailField label="状态">
        <Badge variant={status.variant} className={status.className}>
          {status.label}
        </Badge>
      </DetailField>
      <DetailField label="HTTP 状态">{log.statusCode ?? "—"}</DetailField>
      <DetailField label="TTFB">{formatMs(log.ttfbMs)}</DetailField>
      <DetailField label="延迟">{formatMs(log.latencyMs)}</DetailField>
      <DetailField label="费用">{formatCost(log.cost)}</DetailField>
      <DetailField label="API Key ID">{log.keyId ?? "—"}</DetailField>
      <DetailField label="Intent ID">{log.intentId ?? "—"}</DetailField>
      <DetailField label="最终请求">
        {log.isFinal === null ? "—" : log.isFinal ? "是" : "否"}
      </DetailField>
      <DetailField label="结束原因">{log.streamEndReason ?? "—"}</DetailField>
      {log.errorCode || log.errorMessage ? (
        <>
          <DetailField label="错误代码">{log.errorCode ?? "—"}</DetailField>
          <DetailField label="错误信息">{log.errorMessage ?? "—"}</DetailField>
        </>
      ) : null}
      <DetailField label="输入 Tokens">{tokens.input}</DetailField>
      <DetailField label="缓存输入 Tokens">{tokens.cachedInput}</DetailField>
      <DetailField label="输出 Tokens">{tokens.output}</DetailField>
      <DetailField label="总 Tokens">{tokens.total}</DetailField>
    </div>
  );
}

export function LogsPage() {
  const { api } = useAuth();
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [selected, setSelected] = useState<RequestLog | null>(null);

  const loadLogs = useCallback((signal: AbortSignal) => {
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    return api<RequestLogsResponse>(`/api/request-logs?${params}`, { signal });
  }, [api, cursor, filters]);
  const loadKeys = useCallback(
    (signal: AbortSignal) =>
      api<ApiKeysResponse>("/api/api-keys", { signal }),
    [api],
  );
  const logs = useResource(loadLogs);
  const keys = useResource(loadKeys);
  const dateRange: DateRange | undefined = filters.dateFrom
    ? {
        from: parseDate(filters.dateFrom),
        to: parseDate(filters.dateTo),
      }
    : undefined;

  function updateFilters(values: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...values }));
    setHistory([]);
    setCursor(null);
  }

  function updateFilter(name: keyof Filters, value: string) {
    updateFilters({ [name]: value });
  }

  function nextPage() {
    if (!logs.data?.nextCursor) return;
    setHistory((current) => [...current, cursor]);
    setCursor(logs.data.nextCursor);
  }

  function previousPage() {
    setHistory((current) => {
      if (!current.length) return current;
      setCursor(current[current.length - 1] ?? null);
      return current.slice(0, -1);
    });
  }

  return (
    <main className="flex w-full flex-col gap-6 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
      <section>
        <h1 className="text-2xl font-bold">请求日志</h1>
      </section>

      <div className="grid gap-2 sm:grid-cols-2 sm:items-center xl:grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_9rem_16rem]">
        <Input
          value={filters.modelId}
          onChange={(event) => updateFilter("modelId", event.target.value)}
          placeholder="模型"
          aria-label="模型"
          className="w-full"
        />
        <div>
          <Select
            value={filters.keyId || "all"}
            onValueChange={(value) =>
              updateFilter("keyId", value === "all" ? "" : value)
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="API Key" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              {keys.data?.items.map((key) => (
                <SelectItem key={key.id} value={key.id}>
                  {key.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Select
            value={filters.status || "all"}
            onValueChange={(value) =>
              updateFilter("status", value === "all" ? "" : value)
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="success">成功</SelectItem>
              <SelectItem value="failed">失败</SelectItem>
              <SelectItem value="aborted">已中止</SelectItem>
              <SelectItem value="incomplete">未完成</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                type="button"
                className="w-full justify-start font-normal"
              >
                <CalendarDays className="text-muted-foreground" />
                {formatDateRange(dateRange)}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="max-h-[70svh] w-auto max-w-[calc(100vw-1rem)] overflow-auto p-0"
            >
              <Calendar
                mode="range"
                selected={dateRange}
                onSelect={(range) => {
                  updateFilters({
                    dateFrom: range?.from
                      ? format(range.from, "yyyy-MM-dd")
                      : "",
                    dateTo: range?.to ? format(range.to, "yyyy-MM-dd") : "",
                  });
                }}
                defaultMonth={dateRange?.from}
                numberOfMonths={2}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {logs.error && !logs.data ? (
        <ErrorState message={logs.error} retry={() => void logs.reload()} />
      ) : null}
      {logs.loading && !logs.data ? (
        <LoadingState label="正在读取请求日志" />
      ) : null}

      {logs.data ? (
        <>
          <section className="overflow-x-auto rounded-lg border">
            <Table className="min-w-245">
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="px-3 py-2">请求时间</TableHead>
                  <TableHead className="px-3 py-2">路径</TableHead>
                  <TableHead className="px-3 py-2">模型</TableHead>
                  <TableHead className="px-3 py-2">状态</TableHead>
                  <TableHead className="px-3 py-2">TTFB / 延迟</TableHead>
                  <TableHead className="px-3 py-2">
                    输入 / 缓存 / 输出
                  </TableHead>
                  <TableHead className="px-3 py-2">费用</TableHead>
                  <TableHead className="px-3 py-2">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.data.items.length ? (
                  logs.data.items.map((log) => {
                    const status = getStatusBadge(log);
                    const tokens = getTokens(log.tokensInfo);
                    return (
                      <TableRow key={log.id} className="border-t align-top">
                        <TableCell className="px-3 py-2 text-xs">
                          {formatRequestTime(log.requestTime)}
                        </TableCell>
                        <TableCell className="max-w-56 px-3 py-2 text-xs">
                          {log.path}
                        </TableCell>
                        <TableCell className="px-3 py-2 text-xs">
                          <ModelLabel log={log} />
                        </TableCell>
                        <TableCell className="px-3 py-2 text-xs">
                          <Badge
                            variant={status.variant}
                            className={status.className}
                          >
                            {status.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="px-3 py-2 text-xs">
                          {formatMs(log.ttfbMs)} / {formatMs(log.latencyMs)}
                        </TableCell>
                        <TableCell className="px-3 py-2 text-xs">
                          {tokens.input} / {tokens.cachedInput} /{" "}
                          {tokens.output}
                        </TableCell>
                        <TableCell className="px-3 py-2 text-xs">
                          {formatCost(log.cost)}
                        </TableCell>
                        <TableCell className="px-3 py-2 text-xs">
                          <Tooltip content="查看详情" side="left">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setSelected(log)}
                              aria-label="查看详情"
                            >
                              <Info />
                            </Button>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    );
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={8} className="p-0">
                      <EmptyState className="min-h-32" />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </section>
          <section className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-sm text-muted-foreground">
              本页 {logs.data.items.length} 条
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={!history.length}
                onClick={previousPage}
              >
                <ChevronLeft /> 上一页
              </Button>
              <span className="min-w-16 text-center text-sm text-muted-foreground">
                第 {history.length + 1} 页
              </span>
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={!logs.data.hasMore}
                onClick={nextPage}
              >
                下一页 <ChevronRight />
              </Button>
            </div>
          </section>
        </>
      ) : null}

      {selected ? (
        <Modal
          title="请求详情"
          contentClassName="sm:max-w-4xl"
          onClose={() => setSelected(null)}
        >
          <LogDetails log={selected} />
        </Modal>
      ) : null}
    </main>
  );
}
