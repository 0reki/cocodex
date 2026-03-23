"use client";

import type { SavedAccountSummary, WorkspaceChoice } from "../types/account-types";

type LoginResponse = {
  error?: string;
  requiresOtp?: boolean;
  requiresWorkspace?: boolean;
  sessionId?: string;
  workspaces?: WorkspaceChoice[];
  account?: SavedAccountSummary;
} | null;

async function readLoginResponse(response: Response): Promise<LoginResponse> {
  return (await response.json().catch(() => null)) as LoginResponse;
}

async function unwrapLoginResponse(response: Response) {
  const data = await readLoginResponse(response);
  if (!response.ok) {
    throw new Error(data?.error ?? `HTTP ${response.status}`);
  }
  return data;
}

export async function startAccountLogin(payload: {
  email: string;
  password?: string;
  relogin?: boolean;
  systemCreated?: boolean;
}) {
  const response = await fetch("/api/accounts/login/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return unwrapLoginResponse(response);
}

export async function verifyAccountOtp(payload: {
  sessionId: string;
  code: string;
}) {
  const response = await fetch("/api/accounts/login/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return unwrapLoginResponse(response);
}

export async function completeAccountWorkspaceSelection(payload: {
  sessionId: string;
  workspaceId: string;
}) {
  const response = await fetch("/api/accounts/login/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return unwrapLoginResponse(response);
}
