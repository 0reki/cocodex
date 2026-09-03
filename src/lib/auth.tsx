import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ApiError, fetchJson, jsonBody } from "@/lib/api";
import type { AuthResponse, PortalUser, TokenEnvelope } from "@/types/api";

type AuthSession = {
  user: PortalUser;
  accessToken: TokenEnvelope;
};

type AuthContextValue = {
  ready: boolean;
  user: PortalUser | null;
  login: (username: string, password: string) => Promise<void>;
  register: (
    inviteToken: string,
    username: string,
    password: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
  updateCurrentUser: (user: PortalUser) => void;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
};

const STORAGE_KEY = "cocodex.session.v1";
const REFRESH_MARGIN_SECONDS = 30;
export const PORTAL_PASSWORD_MIN_LENGTH = 8;
export const PORTAL_PASSWORD_MAX_LENGTH = 128;
const AuthContext = createContext<AuthContextValue | null>(null);

function isTokenEnvelope(value: unknown): value is TokenEnvelope {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<TokenEnvelope>;
  return typeof token.token === "string" && typeof token.expiresAt === "number";
}

function readStoredSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AuthSession>;
    if (
      !value.user ||
      typeof value.user.id !== "string" ||
      !isTokenEnvelope(value.accessToken)
    ) {
      return null;
    }
    const session = { user: value.user, accessToken: value.accessToken };
    if ("refreshToken" in value) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    }
    return session;
  } catch {
    return null;
  }
}

function toSession(response: AuthResponse): AuthSession {
  return {
    user: response.user,
    accessToken: response.accessToken,
  };
}

function tokenIsFresh(token: TokenEnvelope) {
  return (
    token.expiresAt > Math.floor(Date.now() / 1000) + REFRESH_MARGIN_SECONDS
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<AuthSession | null>(() =>
    readStoredSession(),
  );
  const [ready, setReady] = useState(false);
  const sessionRef = useRef(session);
  const refreshPromise = useRef<Promise<AuthSession | null> | null>(null);

  const persist = useCallback((next: AuthSession | null) => {
    sessionRef.current = next;
    setSessionState(next);
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  }, []);

  const refresh = useCallback(async () => {
    if (refreshPromise.current) return refreshPromise.current;
    refreshPromise.current = fetchJson<AuthResponse>("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
    })
      .then((response) => {
        const next = toSession(response);
        persist(next);
        return next;
      })
      .catch(() => {
        persist(null);
        return null;
      })
      .finally(() => {
        refreshPromise.current = null;
      });
    return refreshPromise.current;
  }, [persist]);

  useEffect(() => {
    const current = sessionRef.current;
    if (current && tokenIsFresh(current.accessToken)) {
      setReady(true);
      return;
    }
    void refresh().finally(() => setReady(true));
  }, [refresh]);

  useEffect(() => {
    const syncSession = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        const next = readStoredSession();
        sessionRef.current = next;
        setSessionState(next);
      }
    };
    window.addEventListener("storage", syncSession);
    return () => window.removeEventListener("storage", syncSession);
  }, []);

  const login = useCallback(
    async (username: string, password: string) => {
      const response = await fetchJson<AuthResponse>("/api/auth/login", {
        method: "POST",
        credentials: "include",
        ...jsonBody({ username, password }),
      });
      persist(toSession(response));
    },
    [persist],
  );

  const register = useCallback(
    async (inviteToken: string, username: string, password: string) => {
      const response = await fetchJson<AuthResponse>("/api/auth/register", {
        method: "POST",
        credentials: "include",
        ...jsonBody({ inviteToken, username, password }),
      });
      persist(toSession(response));
    },
    [persist],
  );

  const logout = useCallback(async () => {
    persist(null);
    await fetchJson<{ ok: true }>("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    }).catch(() => undefined);
  }, [persist]);
  const updateCurrentUser = useCallback(
    (user: PortalUser) => {
      const current = sessionRef.current;
      if (current?.user.id === user.id) persist({ ...current, user });
    },
    [persist],
  );

  const api = useCallback(
    async <T,>(path: string, init: RequestInit = {}) => {
      let current = sessionRef.current;
      if (!current) throw new ApiError("请先登录", 401, "missing_session");
      if (!tokenIsFresh(current.accessToken)) current = await refresh();
      if (!current) throw new ApiError("登录已过期", 401, "expired_session");

      try {
        return await fetchJson<T>(path, init, current.accessToken.token);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        current = await refresh();
        if (!current) throw error;
        return fetchJson<T>(path, init, current.accessToken.token);
      }
    },
    [refresh],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      user: session?.user ?? null,
      login,
      register,
      logout,
      updateCurrentUser,
      api,
    }),
    [api, login, logout, ready, register, session?.user, updateCurrentUser],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
