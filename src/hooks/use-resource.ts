import { useCallback, useEffect, useState } from "react";

export function useResource<T>(loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loader();
      setData(next);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请求失败");
      return null;
    } finally {
      setLoading(false);
    }
  }, [loader]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  return { data, setData, error, loading, reload };
}
