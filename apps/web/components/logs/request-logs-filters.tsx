"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { format } from "date-fns";
import { type DateRange } from "react-day-picker";
import { Button } from "@workspace/ui/components/button";
import { Calendar } from "@workspace/ui/components/calendar";
import { Input } from "@workspace/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover";
import { useLocale } from "@/components/providers/locale-provider";

type ApiKeyOption = {
  id: string;
  name: string;
  apiKey: string;
};

function parseDate(value: string) {
  if (!value) return undefined;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function formatDateRangeLabel(range: DateRange | undefined, emptyLabel: string) {
  if (!range?.from) return emptyLabel;
  if (!range.to) return format(range.from, "LLL dd, y");
  return `${format(range.from, "LLL dd, y")} - ${format(range.to, "LLL dd, y")}`;
}

export function RequestLogsFilters(props: {
  initialKeyId: string;
  initialModelId: string;
  initialStatus: string;
  initialDateFrom: string;
  initialDateTo: string;
  pageSize: number;
}) {
  const { t } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [keyOptions, setKeyOptions] = React.useState<ApiKeyOption[]>([]);
  const [keyId, setKeyId] = React.useState(props.initialKeyId);
  const [modelId, setModelId] = React.useState(props.initialModelId);
  const [status, setStatus] = React.useState(props.initialStatus);
  const [dateRange, setDateRange] = React.useState<DateRange | undefined>({
    from: parseDate(props.initialDateFrom),
    to: parseDate(props.initialDateTo),
  });

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/api-keys", { cache: "no-store" });
        const data = (await res.json()) as { items?: ApiKeyOption[] };
        if (cancelled || !res.ok) return;
        setKeyOptions(Array.isArray(data.items) ? data.items : []);
      } catch {
        if (!cancelled) setKeyOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyFilters = React.useCallback(() => {
    const params = new URLSearchParams({
      page: "1",
      pageSize: String(props.pageSize),
    });
    if (keyId.trim()) params.set("keyId", keyId.trim());
    if (modelId.trim()) params.set("model", modelId.trim());
    if (status.trim()) params.set("status", status.trim());
    if (dateRange?.from) params.set("dateFrom", format(dateRange.from, "yyyy-MM-dd"));
    if (dateRange?.to) params.set("dateTo", format(dateRange.to, "yyyy-MM-dd"));
    router.push(`${pathname}?${params.toString()}`);
  }, [dateRange, keyId, modelId, pathname, props.pageSize, router, status]);

  const clearFilters = React.useCallback(() => {
    setKeyId("");
    setModelId("");
    setStatus("");
    setDateRange(undefined);
    router.push(`${pathname}?page=1&pageSize=${props.pageSize}`);
  }, [pathname, props.pageSize, router]);

  return (
    <section className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      <Select
        value={keyId || "__all__"}
        onValueChange={(value) => setKeyId(value === "__all__" ? "" : value)}
      >
        <SelectTrigger className="w-full sm:w-72" aria-label={t("logs.keyId")}>
          <SelectValue placeholder={t("logs.keyId")} />
        </SelectTrigger>
        <SelectContent
          position="popper"
          align="start"
          className="w-(--radix-select-trigger-width)"
        >
          <SelectItem value="__all__">{t("common.total")}</SelectItem>
          {keyOptions.map((item) => (
            <SelectItem key={item.id} value={item.apiKey}>
              {item.name?.trim() || item.apiKey}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        value={modelId}
        onChange={(event) => setModelId(event.target.value)}
        placeholder={t("logs.model")}
        className="w-full sm:w-56"
      />
      <Select
        value={status || "__all__"}
        onValueChange={(value) => setStatus(value === "__all__" ? "" : value)}
      >
        <SelectTrigger className="w-full sm:w-56" aria-label={t("logs.status")}>
          <SelectValue placeholder={t("logs.status")} />
        </SelectTrigger>
        <SelectContent
          position="popper"
          align="start"
          className="w-(--radix-select-trigger-width)"
        >
          <SelectItem value="__all__">{t("logs.statusAll")}</SelectItem>
          <SelectItem value="success">{t("logs.statusSuccess")}</SelectItem>
          <SelectItem value="failed">{t("logs.statusFailed")}</SelectItem>
          <SelectItem value="incomplete">{t("logs.statusIncomplete")}</SelectItem>
          <SelectItem value="aborted">{t("logs.statusAborted")}</SelectItem>
        </SelectContent>
      </Select>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="h-8 w-full justify-start px-2.5 font-normal sm:min-w-64 sm:w-auto"
          >
            {formatDateRangeLabel(dateRange, t("logs.requestTime"))}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-auto max-w-[calc(100vw-1rem)] overflow-auto p-0 max-sm:max-h-[70svh]"
          align="start"
        >
          <Calendar
            mode="range"
            selected={dateRange}
            onSelect={setDateRange}
            defaultMonth={dateRange?.from}
            numberOfMonths={2}
          />
        </PopoverContent>
      </Popover>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <Button
          type="button"
          variant="outline"
          onClick={applyFilters}
          className="w-full sm:w-auto"
        >
          {t("common.apply")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={clearFilters}
          className="w-full sm:w-auto"
        >
          {t("common.clear")}
        </Button>
      </div>
    </section>
  );
}
