"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type ToastType = "success" | "error" | "info";

type ToastItem = {
  id: number;
  type: ToastType;
  message: string;
  durationMs: number;
};

type ToastContextValue = {
  info: (message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

function ToastCard({
  item,
  onDone,
}: {
  item: ToastItem;
  onDone: (id: number) => void;
}) {
  const [shrink, setShrink] = useState(false);

  useEffect(() => {
    // Delay one tick to ensure the initial 100% bar is painted before shrinking.
    const startTimer = window.setTimeout(() => setShrink(true), 40);
    const timer = window.setTimeout(() => onDone(item.id), item.durationMs);
    return () => {
      window.clearTimeout(startTimer);
      window.clearTimeout(timer);
    };
  }, [item.durationMs, item.id, onDone]);

  const progressClass =
    item.type === "success"
      ? "bg-green-500"
      : item.type === "error"
        ? "bg-red-500"
        : "bg-sky-500";

  return (
    <div className="overflow-hidden rounded-md border border-neutral-200 bg-white text-sm text-neutral-900 shadow-sm">
      <div className="px-3 py-2">{item.message}</div>
      <div className="h-1.5 w-full bg-neutral-200/90">
        <div
          className={`h-full ${progressClass}`}
          style={{
            width: shrink ? "0%" : "100%",
            transition: `width ${item.durationMs}ms linear`,
          }}
        />
      </div>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const push = useCallback((type: ToastType, message: string, durationMs = 5000) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setItems((prev) => [...prev, { id, type, message, durationMs }]);
  }, []);

  const success = useCallback((message: string) => push("success", message), [push]);
  const error = useCallback((message: string) => push("error", message), [push]);
  const info = useCallback((message: string) => push("info", message), [push]);

  const value = useMemo<ToastContextValue>(
    () => ({ success, error, info }),
    [error, info, success],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {mounted
        ? createPortal(
          createElement(
            "div",
            {
              className:
                "pointer-events-none fixed top-[max(env(safe-area-inset-top)+3.5rem)] right-3 z-[1000] flex w-full max-w-xs flex-col gap-2 sm:right-4",
            },
            items.map((item) => (
              <ToastCard key={item.id} item={item} onDone={remove} />
            )),
          ),
          document.body,
        )
        : null}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used inside ToastProvider");
  }
  return context;
}
