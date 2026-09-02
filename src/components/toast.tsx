import * as ToastPrimitive from "@radix-ui/react-toast";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "@/ui/lib/utils";

type ToastTone = "success" | "error" | "info";

type ToastContent = {
  title: string;
  description?: string;
  detail?: string;
};

type ToastItem = ToastContent & {
  id: number;
  open: boolean;
  tone: ToastTone;
};

type ToastContextValue = {
  success: (content: ToastContent) => void;
  error: (content: ToastContent) => void;
  info: (content: ToastContent) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const icons = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const nextId = useRef(0);
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((tone: ToastTone, content: ToastContent) => {
    const id = ++nextId.current;
    setItems((current) => [
      ...current.slice(-2),
      { ...content, id, open: true, tone },
    ]);
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      success: (content) => push("success", content),
      error: (content) => push("error", content),
      info: (content) => push("info", content),
    }),
    [push],
  );

  function setOpen(id: number, open: boolean) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, open } : item)),
    );
    if (!open) {
      window.setTimeout(() => {
        setItems((current) => current.filter((item) => item.id !== id));
      }, 200);
    }
  }

  return (
    <ToastContext value={value}>
      <ToastPrimitive.Provider duration={4000} swipeDirection="right">
        {children}
        {items.map((item) => {
          const Icon = icons[item.tone];
          return (
            <ToastPrimitive.Root
              key={item.id}
              open={item.open}
              onOpenChange={(open) => setOpen(item.id, open)}
              className={cn(
                "pointer-events-auto relative flex w-full gap-3 rounded-xl border bg-popover p-4 pr-10 text-popover-foreground shadow-lg",
                "data-[state=open]:animate-in data-[state=open]:slide-in-from-right-full data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
                "data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform data-[swipe=end]:animate-out data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)]",
                item.tone === "error" && "border-destructive/30",
              )}
            >
              <span className="flex h-5 shrink-0 items-center">
                <Icon
                  className={cn(
                    "size-4",
                    item.tone === "success" &&
                      "text-emerald-600 dark:text-emerald-400",
                    item.tone === "error" && "text-destructive",
                    item.tone === "info" && "text-muted-foreground",
                  )}
                />
              </span>
              <div className="min-w-0 flex-1">
                <ToastPrimitive.Title className="break-words text-sm font-semibold">
                  {item.title}
                </ToastPrimitive.Title>
                {item.description ? (
                  <ToastPrimitive.Description className="mt-1 text-sm text-muted-foreground">
                    {item.description}
                  </ToastPrimitive.Description>
                ) : null}
                {item.detail ? (
                  <p className="mt-2 max-h-20 overflow-auto break-words text-xs text-muted-foreground">
                    {item.detail}
                  </p>
                ) : null}
              </div>
              <ToastPrimitive.Close
                className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                aria-label="关闭"
              >
                <X className="size-3.5" />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          );
        })}
        <ToastPrimitive.Viewport
          className="fixed bottom-0 right-0 z-[100] flex w-full max-w-sm flex-col gap-2 p-4 outline-none"
          hotkey={["F8"]}
          label="通知"
        />
      </ToastPrimitive.Provider>
    </ToastContext>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}
