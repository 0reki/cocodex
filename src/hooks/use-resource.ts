import { useCallback, useEffect, useRef, useState } from "react";

export function useResource<T>(loader: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const activeRequest = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setError(null);

    try {
      const next = await loader(controller.signal);
      if (controller.signal.aborted || activeRequest.current !== controller) {
        return null;
      }
      setData(next);
      return next;
    } catch (cause) {
      if (controller.signal.aborted || activeRequest.current !== controller) {
        return null;
      }
      setError(cause instanceof Error ? cause.message : "请求失败");
      return null;
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  }, [loader]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => {
      window.clearTimeout(timer);
      const request = activeRequest.current;
      activeRequest.current = null;
      request?.abort();
    };
  }, [reload]);

  return { data, setData, error, loading, reload };
}
