"use client";

import type { ApiKeyRecord, ApiKeysResponse } from "../types/api-key-types";

async function readJson<T>(response: Response) {
  return (await response.json()) as T;
}

export async function listApiKeys() {
  const response = await fetch("/api/api-keys", { cache: "no-store" });
  const data = await readJson<ApiKeysResponse>(response);
  if (!response.ok) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return Array.isArray(data.items) ? data.items : [];
}

export async function createApiKey(payload: {
  name: string;
  quota: number | null;
  expiresAt: string | null;
}) {
  const response = await fetch("/api/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await readJson<{ ok?: boolean; item?: ApiKeyRecord; error?: string }>(response);
  if (!response.ok || !data.ok || !data.item) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return data.item;
}

export async function deleteApiKey(id: string) {
  const response = await fetch(`/api/api-keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  const data = await readJson<{ ok?: boolean; error?: string }>(response);
  if (!response.ok || !data.ok) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
}

export async function updateApiKey(
  id: string,
  payload: {
    name: string;
    quota: number | null;
    expiresAt: string | null;
  },
) {
  const response = await fetch(`/api/api-keys/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await readJson<{ ok?: boolean; item?: ApiKeyRecord; error?: string }>(response);
  if (!response.ok || !data.ok || !data.item) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return data.item;
}
