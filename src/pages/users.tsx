import { Spinner } from "@/ui/components/spinner";
import { Link } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";

import {
  EmptyState,
  ErrorState,
  CopyButton,
  InlineNotice,
  LoadingState,
  Modal,
  StatusPill,
  Tooltip,
} from "@/components/ui";
import { useResource } from "@/hooks/use-resource";
import { jsonBody } from "@/lib/api";
import {
  PORTAL_PASSWORD_MAX_LENGTH,
  PORTAL_PASSWORD_MIN_LENGTH,
  useAuth,
} from "@/lib/auth";
import { formatDate } from "@/lib/format";
import {
  QUOTA_FIELDS,
  formatQuotaValue,
  parseQuotaInput,
  quotaInputText,
} from "@/lib/quota";
import type {
  OpenAIAccount,
  OpenAIAccountsResponse,
  PortalInvitationResponse,
  PortalUser,
  QuotaLimits,
  QuotaProfile,
  QuotaProfilesResponse,
  UpstreamPlatform,
  UsersResponse,
} from "@/types/api";
import { Button } from "@/ui/components/button";
import { Checkbox } from "@/ui/components/checkbox";
import { Input } from "@/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/table";

type UserMutationResponse = { ok: true; user: PortalUser };
type UsersPageData = UsersResponse & {
  accounts: OpenAIAccount[];
  profiles: QuotaProfile[];
};

const PLATFORM_LABELS: Record<UpstreamPlatform, string> = {
  windows: "Windows",
  linux: "Linux",
  all: "通用",
};

type UpstreamOption = {
  accountId: string;
  email: string;
  platforms: UpstreamPlatform[];
  disabled: boolean;
};

// Assignment is by account_id; the same account has one login row per
// platform, so collapse those rows into a single option.
function upstreamOptions(accounts: OpenAIAccount[]): UpstreamOption[] {
  const byAccount = new Map<string, UpstreamOption>();
  for (const account of accounts) {
    const option = byAccount.get(account.accountId) ?? {
      accountId: account.accountId,
      email: account.email,
      platforms: [],
      disabled: true,
    };
    if (!option.platforms.includes(account.platform)) {
      option.platforms.push(account.platform);
    }
    // The account is usable if any of its platform logins is not disabled.
    if (account.status !== "disabled") option.disabled = false;
    byAccount.set(account.accountId, option);
  }
  return [...byAccount.values()];
}

function UserForm({
  item,
  onClose,
  onSaved,
}: {
  item: PortalUser | null;
  onClose: () => void;
  onSaved: (user?: PortalUser) => void;
}) {
  const { api } = useAuth();
  const [username, setUsername] = useState(item?.username ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (!item) {
        const response = await api<UserMutationResponse>("/api/users", {
          method: "POST",
          ...jsonBody({ username: username.trim(), password }),
        });
        onSaved(response.user);
      } else {
        let updated = item;
        if (username.trim() !== item.username) {
          const response = await api<UserMutationResponse>(
            `/api/users/${item.id}/username`,
            {
              method: "PUT",
              ...jsonBody({ username: username.trim() }),
            },
          );
          updated = { ...item, ...response.user };
        }
        if (password) {
          await api(`/api/users/${item.id}/password`, {
            method: "PUT",
            ...jsonBody({ password }),
          });
        }
        onSaved(updated);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      <label className="grid gap-1.5 text-sm font-medium">
        <span>用户名</span>
        <Input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="off"
          autoFocus
          required
        />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        <span>{item ? "新密码（留空则不修改）" : "初始密码"}</span>
        <Input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          required={!item}
          minLength={PORTAL_PASSWORD_MIN_LENGTH}
          maxLength={PORTAL_PASSWORD_MAX_LENGTH}
        />
      </label>
      <footer className="flex justify-end gap-2 pt-4">
        <Button variant="outline" type="button" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? (
            <>
              <Spinner />
              <span className="sr-only">处理中</span>
            </>
          ) : (
            "继续"
          )}
        </Button>
      </footer>
    </form>
  );
}

type OverrideDraft = Record<
  keyof QuotaLimits,
  { enabled: boolean; text: string }
>;

// A user's profile and, field by field, whether to override it.
function UserQuotaForm({
  item,
  profiles,
  onClose,
  onSaved,
}: {
  item: PortalUser;
  profiles: QuotaProfile[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useAuth();
  const quota = item.quota;
  const defaultProfile = profiles.find((profile) => profile.isDefault);
  const [profileId, setProfileId] = useState<string>(
    quota?.profileId ?? defaultProfile?.id ?? "",
  );
  const [overrides, setOverrides] = useState<OverrideDraft>(() => {
    const draft = {} as OverrideDraft;
    for (const field of QUOTA_FIELDS) {
      const overridden = quota ? field.key in quota.overrides : false;
      draft[field.key] = {
        enabled: overridden,
        text: quotaInputText(
          overridden
            ? quota?.overrides[field.key]
            : quota?.effective[field.key],
        ),
      };
    }
    return draft;
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const profile = profiles.find((candidate) => candidate.id === profileId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload: Partial<Record<keyof QuotaLimits, number | null>> = {};
    for (const field of QUOTA_FIELDS) {
      const draft = overrides[field.key];
      if (!draft.enabled) continue;
      const parsed = parseQuotaInput(field.key, draft.text);
      if ("error" in parsed) {
        setError(parsed.error);
        return;
      }
      payload[field.key] = parsed.value;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api(`/api/users/${item.id}/quota-profile`, {
        method: "PUT",
        ...jsonBody({
          profileId: profile?.isDefault ? null : profileId || null,
          overrides: payload,
        }),
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      <label className="grid gap-1.5 text-sm font-medium">
        <span>额度配置</span>
        <Select value={profileId} onValueChange={setProfileId}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="选择额度配置" />
          </SelectTrigger>
          <SelectContent>
            {profiles.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.name}
                {candidate.isDefault ? "（默认）" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {QUOTA_FIELDS.map((field) => {
        const draft = overrides[field.key];
        const inherited = profile
          ? formatQuotaValue(field.key, profile[field.key])
          : "—";
        return (
          <div key={field.key} className="grid gap-1.5 text-sm">
            <label className="flex items-center gap-2 font-medium">
              <Checkbox
                checked={draft.enabled}
                onCheckedChange={(checked) =>
                  setOverrides((current) => ({
                    ...current,
                    [field.key]: { ...draft, enabled: checked === true },
                  }))
                }
              />
              <span>
                覆盖{field.label}
                <span className="ml-2 font-normal text-muted-foreground">
                  配置值：{inherited}
                </span>
              </span>
            </label>
            {draft.enabled ? (
              <Input
                inputMode="decimal"
                value={draft.text}
                placeholder={field.key === "weeklySharePercent" ? "" : "不限"}
                onChange={(event) =>
                  setOverrides((current) => ({
                    ...current,
                    [field.key]: { ...draft, text: event.target.value },
                  }))
                }
              />
            ) : null}
          </div>
        );
      })}
      <footer className="flex justify-end gap-2 pt-4">
        <Button variant="outline" type="button" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" disabled={submitting || !profileId}>
          {submitting ? (
            <>
              <Spinner />
              <span className="sr-only">处理中</span>
            </>
          ) : (
            "保存"
          )}
        </Button>
      </footer>
    </form>
  );
}

function QuotaSummary({ item }: { item: PortalUser }) {
  const quota = item.quota;
  if (!quota) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="grid gap-0.5">
      <span className="font-medium">
        {quota.profileName ?? "默认"}
        {Object.keys(quota.overrides).length ? (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            （已覆盖 {Object.keys(quota.overrides).length} 项）
          </span>
        ) : null}
      </span>
      <span className="text-xs text-muted-foreground">
        {QUOTA_FIELDS.map(
          (field) =>
            `${field.label} ${formatQuotaValue(field.key, quota.effective[field.key])}`,
        ).join(" · ")}
      </span>
    </div>
  );
}

export function UsersPage() {
  const { api, user: currentUser, updateCurrentUser } = useAuth();
  const [editing, setEditing] = useState<PortalUser | "new" | null>(null);
  const [editingQuota, setEditingQuota] = useState<PortalUser | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<PortalInvitationResponse | null>(
    null,
  );
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [users, accounts, profiles] = await Promise.all([
        api<UsersResponse>("/api/users", { signal }),
        api<OpenAIAccountsResponse>(
          "/api/openai-accounts?page=1&pageSize=500",
          { signal },
        ),
        api<QuotaProfilesResponse>("/api/quota-profiles", { signal }),
      ]);
      return {
        ...users,
        accounts: accounts.items,
        profiles: profiles.items,
      } satisfies UsersPageData;
    },
    [api],
  );
  const { data, error, loading, reload } = useResource(load);

  async function setEnabled(item: PortalUser, enabled: boolean) {
    if (
      !enabled &&
      !window.confirm(`确定停用 ${item.username} 吗？其 API Key 会立即失效。`)
    ) {
      return;
    }
    setBusy(item.id);
    setActionError(null);
    try {
      await api(`/api/users/${item.id}/${enabled ? "enable" : "disable"}`, {
        method: "POST",
      });
      await reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  async function createInvitation() {
    setBusy("invitation");
    setActionError(null);
    try {
      setInvitation(
        await api<PortalInvitationResponse>("/api/user-invitations", {
          method: "POST",
        }),
      );
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "生成邀请失败");
    } finally {
      setBusy(null);
    }
  }

  async function assignUpstream(item: PortalUser, accountId: string | null) {
    setBusy(`upstream:${item.id}`);
    setActionError(null);
    try {
      await api(`/api/users/${item.id}/upstream`, {
        method: "PUT",
        ...jsonBody({ accountId }),
      });
      await reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "分配上游失败");
    } finally {
      setBusy(null);
    }
  }

  function saved(user?: PortalUser) {
    if (user && user.id === currentUser?.id) updateCurrentUser(user);
    setEditing(null);
    void reload();
  }

  return (
    <main className="flex w-full flex-col gap-6 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
      <section>
        <h1 className="text-2xl font-bold">用户</h1>
      </section>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          type="button"
          disabled={busy === "invitation"}
          onClick={() => void createInvitation()}
        >
          {busy === "invitation" ? <Spinner /> : <Link />}
          邀请用户
        </Button>
        <Button type="button" onClick={() => setEditing("new")}>
          新建用户
        </Button>
      </div>

      {actionError ? (
        <InlineNotice tone="error">{actionError}</InlineNotice>
      ) : null}
      {error && !data ? (
        <ErrorState message={error} retry={() => void reload()} />
      ) : null}
      {loading && !data ? <LoadingState label="正在读取用户" /> : null}

      {data ? (
        <section className="overflow-x-auto rounded-xl border">
          {data.items.length ? (
            <Table className="min-w-260">
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>上游账号</TableHead>
                  <TableHead>额度</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">
                      {item.username}
                    </TableCell>
                    <TableCell>
                      {item.role === "admin" ? "管理员" : "用户"}
                    </TableCell>
                    <TableCell>
                      <StatusPill
                        value={item.enabled ? "enabled" : "disabled"}
                      />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={item.accountId ?? "unassigned"}
                        disabled={busy === `upstream:${item.id}`}
                        onValueChange={(value) =>
                          void assignUpstream(
                            item,
                            value === "unassigned" ? null : value,
                          )
                        }
                      >
                        <SelectTrigger className="w-60">
                          <SelectValue placeholder="未分配" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unassigned">未分配</SelectItem>
                          {upstreamOptions(data.accounts).map((account) => (
                            <SelectItem
                              key={account.accountId}
                              value={account.accountId}
                              disabled={account.disabled}
                            >
                              {account.email}
                              {account.platforms.length
                                ? `（${account.platforms
                                    .map(
                                      (platform) => PLATFORM_LABELS[platform],
                                    )
                                    .join(" / ")}）`
                                : ""}
                              {account.disabled ? " 已停用" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <QuotaSummary item={item} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(item.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          variant="outline"
                          type="button"
                          onClick={() => setEditing(item)}
                        >
                          编辑
                        </Button>
                        <Button
                          variant="outline"
                          type="button"
                          onClick={() => setEditingQuota(item)}
                        >
                          额度
                        </Button>
                        {item.enabled ? (
                          <Tooltip
                            content={
                              item.id === currentUser?.id
                                ? "不能停用自己"
                                : undefined
                            }
                          >
                            <Button
                              variant="outline"
                              type="button"
                              disabled={
                                busy === item.id || item.id === currentUser?.id
                              }
                              onClick={() => void setEnabled(item, false)}
                            >
                              停用
                            </Button>
                          </Tooltip>
                        ) : (
                          <Button
                            variant="outline"
                            type="button"
                            disabled={busy === item.id}
                            onClick={() => void setEnabled(item, true)}
                          >
                            启用
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState />
          )}
        </section>
      ) : null}

      {editing ? (
        <Modal
          title={editing === "new" ? "新建用户" : `编辑 ${editing.username}`}
          onClose={() => setEditing(null)}
        >
          <UserForm
            item={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={saved}
          />
        </Modal>
      ) : null}

      {editingQuota && data ? (
        <Modal
          title={`${editingQuota.username} 的额度`}
          onClose={() => setEditingQuota(null)}
        >
          <UserQuotaForm
            item={editingQuota}
            profiles={data.profiles}
            onClose={() => setEditingQuota(null)}
            onSaved={() => {
              setEditingQuota(null);
              void reload();
            }}
          />
        </Modal>
      ) : null}

      {invitation ? (
        <Modal title="生成完成" onClose={() => setInvitation(null)}>
          <div>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2">
              <span className="min-w-0 flex-1 break-all text-sm">
                {invitation.registrationUrl}
              </span>
              <CopyButton
                value={invitation.registrationUrl}
                label="复制注册链接"
              />
            </div>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}
