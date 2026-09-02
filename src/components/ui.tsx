import {
  AlertCircle,
  Box,
  Check,
  Copy,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/components/dialog";
import { cn } from "@/ui/lib/utils";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        {eyebrow ? (
          <div className="text-xs font-medium tracking-widest text-muted-foreground">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description ? (
          <p className="max-w-2xl text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

export function LoadingState({ label = "正在加载" }: { label?: string }) {
  return (
    <div
      className="flex min-h-32 items-center justify-center gap-2 rounded-xl border text-sm text-muted-foreground"
      aria-live="polite"
    >
      <LoaderCircle className="size-4 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div
      className="flex min-h-24 flex-wrap items-center justify-center gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-4 text-sm text-destructive"
      role="alert"
    >
      <AlertCircle className="size-4" />
      <span>{message}</span>
      {retry ? (
        <Button variant="outline" size="sm" type="button" onClick={retry}>
          <RefreshCw className="size-3.5" /> 重试
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex min-h-44 flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground",
        className,
      )}
    >
      <Box className="size-5" />
      <span className="text-sm">没有要显示的内容</span>
    </div>
  );
}

export function StatusPill({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  const tone = ["active", "success", "enabled", "ok"].includes(normalized)
    ? "success"
    : ["disabled", "failed", "error"].includes(normalized)
      ? "danger"
      : "neutral";
  const labels: Record<string, string> = {
    active: "使用中",
    inactive: "待用",
    disabled: "已停用",
    enabled: "已启用",
    success: "成功",
    failed: "失败",
    aborted: "已中止",
    incomplete: "未完成",
  };

  return (
    <Badge
      variant="outline"
      className={cn(
        tone === "success" &&
          "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        tone === "danger" &&
          "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      {labels[normalized] ?? value}
    </Badge>
  );
}

export function Tooltip({
  content,
  children,
  side = "top",
  className,
}: {
  content?: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}) {
  return (
    <span className={cn("group/tooltip relative inline-flex", className)}>
      {children}
      {content ? (
        <span
          role="tooltip"
          className={cn(
            "pointer-events-none invisible absolute z-[200] whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-[11px] font-medium leading-none text-background opacity-0 shadow-md transition-opacity group-focus-within/tooltip:visible group-focus-within/tooltip:opacity-100 group-hover/tooltip:visible group-hover/tooltip:opacity-100",
            side === "top" && "bottom-full left-1/2 mb-1 -translate-x-1/2",
            side === "right" && "left-full top-1/2 ml-1 -translate-y-1/2",
            side === "bottom" && "left-1/2 top-full mt-1 -translate-x-1/2",
            side === "left" && "right-full top-1/2 mr-1 -translate-y-1/2",
          )}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}

export function CopyButton({
  value,
  label = "复制",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <Tooltip content={copied ? "已复制" : label}>
      <Button
        variant="ghost"
        size="icon-sm"
        type="button"
        onClick={() => void copy()}
        aria-label={label}
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
    </Tooltip>
  );
}

export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
  contentClassName,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  contentClassName?: string;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={cn(
          "max-h-[calc(100dvh-2rem)] overflow-y-auto",
          wide && "sm:max-w-2xl",
          contentClassName,
        )}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function InlineNotice({
  tone = "info",
  children,
}: {
  tone?: "info" | "error" | "success";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        tone === "info" && "bg-muted/40 text-muted-foreground",
        tone === "error" &&
          "border-destructive/25 bg-destructive/5 text-destructive",
        tone === "success" &&
          "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      )}
    >
      {children}
    </div>
  );
}
