export function lruGet<K, V extends { expiresAtMs: number }>(
  cache: Map<K, V>,
  key: K,
): V | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

export function lruSet<K, V extends { expiresAtMs: number }>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxSize: number,
) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxSize) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}
