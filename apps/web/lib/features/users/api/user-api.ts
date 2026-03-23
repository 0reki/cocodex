"use client";

import { parseJsonObjectSafe } from "../utils/user-utils";

async function readJsonError(response: Response, fallback: string) {
  const data = (await response.json()) as { error?: string };
  return data.error ?? fallback;
}

export async function createAdminUser(payload: {
  username: string;
  password: string;
  role: "admin" | "user";
}) {
  const response = await fetch("/api/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await readJsonError(response, "Failed to create user"));
  }
}

export async function updateAdminUser(
  userId: string,
  payload: {
    role: "admin" | "user";
    enabled: boolean;
    password?: string;
    userRpmLimit: number | null;
    userMaxInFlight: number | null;
  },
) {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await readJsonError(response, "Failed to update user"));
  }
}

export async function updateAdminUserBalance(
  userId: string,
  payload: {
    mode: "set" | "adjust";
    amount: number;
  },
) {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/balance`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await readJsonError(response, "Failed to update user"));
  }
}

export async function createInboxMessage(payload: {
  recipientUserIds: string[];
  title: string;
  body: string;
}) {
  const response = await fetch("/api/admin/inbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  const data = (parseJsonObjectSafe(raw) ?? {}) as {
    error?: string;
    created?: number;
  };
  if (!response.ok) {
    throw new Error(data.error ?? raw.trim() ?? "Failed to send inbox message");
  }
  return data;
}

export async function deleteAdminUser(userId: string, fallback: string) {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await readJsonError(response, fallback));
  }
}

export async function setAdminUserEnabled(
  userId: string,
  enabled: boolean,
  fallback: string,
) {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    throw new Error(await readJsonError(response, fallback));
  }
}
