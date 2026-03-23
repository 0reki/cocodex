"use client";

import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table";
import { formatTokenCompact } from "@/lib/format/number-format";
import type { LocaleKey } from "@/locales";
import { useLocale } from "@/components/providers/locale-provider";

export type RequestLogRow = {
  id: string;
  intentId: string | null;
  attemptNo: number | null;
  isFinal: boolean | null;
  retryReason: string | null;
  heartbeatCount: number | null;
  streamEndReason: string | null;
  path: string;
  modelId: string | null;
  keyId: string | null;
  serviceTier: string | null;
  statusCode: number | null;
  ttfbMs: number | null;
  latencyMs: number | null;
  tokensInfo: Record<string, unknown> | null;
  totalTokens: number | null;
  cost: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestTime: string;
  createdAt: string;
  updatedAt: string;
};

type TranslateFn = (key: LocaleKey) => string;

function isSuccessfulHttpStatus(statusCode: number | null) {
  return statusCode !== null && statusCode >= 200 && statusCode < 300;
}

function isClientAborted(streamEndReason: string | null) {
  return (
    typeof streamEndReason === "string" &&
    streamEndReason.startsWith("client_aborted")
  );
}

function getStatusBadge(row: RequestLogRow, t: TranslateFn): {
  variant: "secondary" | "outline" | "destructive";
  label: string;
  className: string;
} {
  const { statusCode } = row;
  if (statusCode === null) {
    return { variant: "outline", label: "-", className: "" };
  }
  if (isSuccessfulHttpStatus(statusCode)) {
    if (row.isFinal) {
      return {
        variant: "secondary",
        label: String(statusCode),
        className: "border-emerald-200 bg-emerald-100 text-emerald-800",
      };
    }
    if (isClientAborted(row.streamEndReason)) {
      return {
        variant: "outline",
        label: `${statusCode} ${t("logs.statusAborted")}`,
        className: "border-amber-200 bg-amber-100 text-amber-800",
      };
    }
    const failed = Boolean(row.errorCode || row.streamEndReason);
    return {
      variant: failed ? "destructive" : "outline",
      label: `${statusCode} ${
        failed ? t("logs.statusFailed") : t("logs.statusIncomplete")
      }`,
      className: failed ? "" : "border-amber-200 bg-amber-100 text-amber-800",
    };
  }
  return { variant: "destructive", label: String(statusCode), className: "" };
}

function formatCost(cost: number | null) {
  if (cost === null || Number.isNaN(cost)) return "-";
  return `$${cost.toFixed(6)}`;
}

function formatRequestTime(value: string, locale: string) {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString(locale);
}

function RequestTimeCell({ value, locale }: { value: string; locale: string }) {
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    setDisplay(formatRequestTime(value, locale));
  }, [value, locale]);

  return <>{display}</>;
}

function formatMs(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  const ms = Math.max(0, value);
  if (ms < 1000) return `${ms} ms`;

  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes} m ${seconds.toFixed(1)} s` : `${minutes} m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours} h ${remainMinutes} m` : `${hours} h`;
}

function toTokenNumber(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatTokenCompact(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return formatTokenCompact(parsed);
  }
  return "-";
}

function getTokenCombined(tokensInfo: Record<string, unknown> | null) {
  if (!tokensInfo) return "- / - / -";
  const input = toTokenNumber(tokensInfo.input_tokens);
  const output = toTokenNumber(tokensInfo.output_tokens);
  const details =
    tokensInfo.input_tokens_details &&
    typeof tokensInfo.input_tokens_details === "object"
      ? (tokensInfo.input_tokens_details as Record<string, unknown>)
      : null;
  const cachedInput = toTokenNumber(details?.cached_tokens);
  return `${input} / ${cachedInput} / ${output}`;
}

function getTokenParsed(tokensInfo: Record<string, unknown> | null) {
  if (!tokensInfo) {
    return { input: "-", cachedInput: "-", output: "-", total: "-" };
  }
  const input = toTokenNumber(tokensInfo.input_tokens);
  const output = toTokenNumber(tokensInfo.output_tokens);
  const total = toTokenNumber(tokensInfo.total_tokens);
  const details =
    tokensInfo.input_tokens_details &&
    typeof tokensInfo.input_tokens_details === "object"
      ? (tokensInfo.input_tokens_details as Record<string, unknown>)
      : null;
  const cachedInput = toTokenNumber(details?.cached_tokens);
  return { input, cachedInput, output, total };
}

function PriorityModeBadge({ label }: { label: string }) {
  return (
    <span className="group/priority relative inline-flex shrink-0 items-center leading-none">
      <span
        aria-label={label}
        className="inline-flex h-4 w-4 items-center justify-center rounded-sm text-emerald-500 outline-none"
      >
        <Zap
          className="h-3.5 w-3.5 fill-current"
          fill="currentColor"
          strokeWidth={1.75}
        />
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-[11px] font-medium leading-none text-background shadow-md group-hover/priority:block"
      >
        {label}
      </span>
    </span>
  );
}

function ModelLabel({
  modelId,
  serviceTier,
  priorityTooltip,
}: {
  modelId: string | null;
  serviceTier: string | null;
  priorityTooltip: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 align-middle leading-none">
      {serviceTier === "priority" ? (
        <PriorityModeBadge label={priorityTooltip} />
      ) : null}
      <span className="leading-none">{modelId ?? "-"}</span>
    </span>
  );
}

export function RequestLogsTable({ rows }: { rows: RequestLogRow[] }) {
  const [activeRow, setActiveRow] = useState<RequestLogRow | null>(null);
  const { t, locale } = useLocale();
  const priorityTooltip = t("logs.fastModeTooltip");

  return (
    <>
      <section className="overflow-x-auto rounded-lg border">
        <Table className="min-w-[980px]">
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="px-3 py-2">{t("logs.requestTime")}</TableHead>
              <TableHead className="px-3 py-2">{t("logs.path")}</TableHead>
              <TableHead className="px-3 py-2">{t("logs.model")}</TableHead>
              <TableHead className="px-3 py-2">{t("logs.status")}</TableHead>
              <TableHead className="px-3 py-2">{t("logs.ttfbLatency")}</TableHead>
              <TableHead className="px-3 py-2">
                {t("logs.tokensCombined")}
              </TableHead>
              <TableHead className="px-3 py-2">{t("logs.cost")}</TableHead>
              <TableHead className="px-3 py-2">{t("common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="px-3 py-4 text-sm text-muted-foreground"
                >
                  {t("logs.noLogs")}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((item) => {
                const status = getStatusBadge(item, t);
                return (
                  <TableRow key={item.id} className="border-t align-top">
                    <TableCell className="px-3 py-2 text-xs">
                      <RequestTimeCell value={item.requestTime} locale={locale} />
                    </TableCell>
                    <TableCell className="max-w-56 px-3 py-2 text-xs">
                      {item.path}
                    </TableCell>
                    <TableCell className="px-3 py-2 text-xs">
                      <ModelLabel
                        modelId={item.modelId}
                        serviceTier={item.serviceTier}
                        priorityTooltip={priorityTooltip}
                      />
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
                      {`${formatMs(item.ttfbMs)} / ${formatMs(item.latencyMs)}`}
                    </TableCell>
                    <TableCell className="px-3 py-2 text-xs">
                      {getTokenCombined(item.tokensInfo)}
                    </TableCell>
                    <TableCell className="px-3 py-2 text-xs">
                      {formatCost(item.cost)}
                    </TableCell>
                    <TableCell className="px-3 py-2 text-xs">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setActiveRow(item)}
                      >
                        {t("common.details")}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </section>

      <Dialog
        open={Boolean(activeRow)}
        onOpenChange={(open) => !open && setActiveRow(null)}
      >
        <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t("logs.requestDetails")}</DialogTitle>
          </DialogHeader>
          {activeRow ? (
            (() => {
              const status = getStatusBadge(activeRow, t);
              const parsed = getTokenParsed(activeRow.tokensInfo);
              return (
                <div className="space-y-3 text-sm">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div>
                      <span className="text-muted-foreground">{t("logs.requestTime")}: </span>
                      <span>
                        <RequestTimeCell value={activeRow.requestTime} locale={locale} />
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("logs.path")}: </span>
                      <span>{activeRow.path}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("logs.model")}: </span>
                      <ModelLabel
                        modelId={activeRow.modelId}
                        serviceTier={activeRow.serviceTier}
                        priorityTooltip={priorityTooltip}
                      />
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("logs.status")}: </span>
                      <Badge variant={status.variant} className={status.className}>
                        {status.label}
                      </Badge>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("logs.httpStatus")}: </span>
                      <span>{activeRow.statusCode ?? "-"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("logs.ttfb")}: </span>
                      <span>{formatMs(activeRow.ttfbMs)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("logs.latency")}: </span>
                      <span>{formatMs(activeRow.latencyMs)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("logs.cost")}: </span>
                      <span>{formatCost(activeRow.cost)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("logs.keyId")}: </span>
                      <span>{activeRow.keyId ?? "-"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("logs.intentId")}: </span>
                      <span>{activeRow.intentId ?? "-"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("logs.attempt")}: </span>
                      <span>{activeRow.attemptNo ?? "-"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("logs.final")}: </span>
                      <span>
                        {activeRow.isFinal === null
                          ? "-"
                          : activeRow.isFinal
                            ? "true"
                            : "false"}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("logs.retryReason")}: </span>
                      <span>{activeRow.retryReason ?? "-"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("logs.streamEndReason")}: </span>
                      <span>{activeRow.streamEndReason ?? "-"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t("logs.heartbeatCount")}: </span>
                      <span>{activeRow.heartbeatCount ?? "-"}</span>
                    </div>
                    {activeRow.errorCode || activeRow.errorMessage ? (
                      <>
                        <div>
                          <span className="text-muted-foreground">{t("logs.errorCode")}: </span>
                          <span>{activeRow.errorCode ?? "-"}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">{t("logs.errorMessage")}: </span>
                          <span>{activeRow.errorMessage ?? "-"}</span>
                        </div>
                      </>
                    ) : null}
                    <div>
                      <span className="text-muted-foreground">
                        {t("logs.inputTokens")}:{" "}
                      </span>
                      <span>{parsed.input}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">
                        {t("logs.cachedInputTokens")}:{" "}
                      </span>
                      <span>{parsed.cachedInput}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">
                        {t("logs.outputTokens")}:{" "}
                      </span>
                      <span>{parsed.output}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">
                        {t("logs.totalTokens")}:{" "}
                      </span>
                      <span>{parsed.total}</span>
                    </div>
                  </div>
                </div>
              );
            })()
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
