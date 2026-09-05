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
import type {
  OpenAIAccount,
  OpenAIAccountsResponse,
  PortalInvitationResponse,
  PortalUser,
  UsersResponse,
} from "@/types/api";
import { Button } from "@/ui/components/button";
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
type UsersPageData = UsersResponse & { accounts: OpenAIAccount[] };

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

export function UsersPage() {
  const { api, user: currentUser, updateCurrentUser } = useAuth();
  const [editing, setEditing] = useState<PortalUser | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<PortalInvitationResponse | null>(
    null,
  );
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [users, accounts] = await Promise.all([
        api<UsersResponse>("/api/users", { signal }),
        api<OpenAIAccountsResponse>(
          "/api/openai-accounts?page=1&pageSize=500",
          { signal },
        ),
      ]);
      return { ...users, accounts: accounts.items } satisfies UsersPageData;
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

  async function assignUpstream(
    item: PortalUser,
    sourceAccountId: string | null,
  ) {
    setBusy(`upstream:${item.id}`);
    setActionError(null);
    try {
      await api(`/api/users/${item.id}/upstream`, {
        method: "PUT",
        ...jsonBody({ sourceAccountId }),
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
            <Table className="min-w-220">
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>上游账号</TableHead>
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
                        value={item.sourceAccountId ?? "unassigned"}
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
                          {data.accounts.map((account) => (
                            <SelectItem
                              key={account.id}
                              value={account.id}
                              disabled={account.status === "disabled"}
                            >
                              {account.email}
                              {account.status === "disabled"
                                ? "（已停用）"
                                : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
