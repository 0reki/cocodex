import { Spinner } from "@/ui/components/spinner";
import { useCallback, useState, type FormEvent } from "react";

import {
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
  Modal,
} from "@/components/ui";
import { useResource } from "@/hooks/use-resource";
import { jsonBody } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  QUOTA_FIELDS,
  formatQuotaValue,
  parseQuotaInput,
  quotaInputText,
} from "@/lib/quota";
import type {
  QuotaLimits,
  QuotaProfile,
  QuotaProfilesResponse,
} from "@/types/api";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/table";

type Draft = Record<keyof QuotaLimits, string>;

function draftOf(profile: QuotaProfile | null): Draft {
  const draft = {} as Draft;
  for (const field of QUOTA_FIELDS) {
    draft[field.key] =
      field.key === "weeklySharePercent"
        ? String(profile?.weeklySharePercent ?? 25)
        : quotaInputText(profile?.[field.key]);
  }
  return draft;
}

function ProfileForm({
  item,
  onClose,
  onSaved,
}: {
  item: QuotaProfile | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useAuth();
  const [name, setName] = useState(item?.name ?? "");
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const limits: Partial<Record<keyof QuotaLimits, number | null>> = {};
    for (const field of QUOTA_FIELDS) {
      const parsed = parseQuotaInput(field.key, draft[field.key]);
      if ("error" in parsed) {
        setError(parsed.error);
        return;
      }
      limits[field.key] = parsed.value;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api(
        item ? `/api/quota-profiles/${item.id}` : "/api/quota-profiles",
        {
          method: item ? "PUT" : "POST",
          ...jsonBody({ name: name.trim(), ...limits }),
        },
      );
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
        <span>名称</span>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          autoFocus
          required
        />
      </label>
      {QUOTA_FIELDS.map((field) => (
        <label key={field.key} className="grid gap-1.5 text-sm font-medium">
          <span>{field.label}</span>
          <Input
            inputMode="decimal"
            value={draft[field.key]}
            placeholder={field.key === "weeklySharePercent" ? "" : "不限"}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                [field.key]: event.target.value,
              }))
            }
          />
          <span className="text-xs font-normal text-muted-foreground">
            {field.hint}
          </span>
        </label>
      ))}
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
            "保存"
          )}
        </Button>
      </footer>
    </form>
  );
}

export function QuotaProfilesPage() {
  const { api } = useAuth();
  const [editing, setEditing] = useState<QuotaProfile | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const load = useCallback(
    (signal: AbortSignal) =>
      api<QuotaProfilesResponse>("/api/quota-profiles", { signal }),
    [api],
  );
  const { data, error, loading, reload } = useResource(load);

  async function remove(item: QuotaProfile) {
    if (
      !window.confirm(
        `确定删除额度配置「${item.name}」吗？使用它的用户会改用默认配置。`,
      )
    ) {
      return;
    }
    setBusy(item.id);
    setActionError(null);
    try {
      await api(`/api/quota-profiles/${item.id}`, { method: "DELETE" });
      await reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "删除失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="flex w-full flex-col gap-6 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
      <section>
        <h1 className="text-2xl font-bold">额度配置</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          每个用户使用一个额度配置，可以在用户管理里逐项覆盖。未指定配置的用户使用默认配置。
        </p>
      </section>

      <div className="flex justify-end">
        <Button type="button" onClick={() => setEditing("new")}>
          新建配置
        </Button>
      </div>

      {actionError ? (
        <InlineNotice tone="error">{actionError}</InlineNotice>
      ) : null}
      {error && !data ? (
        <ErrorState message={error} retry={() => void reload()} />
      ) : null}
      {loading && !data ? <LoadingState label="正在读取额度配置" /> : null}

      {data ? (
        <section className="overflow-x-auto rounded-xl border">
          {data.items.length ? (
            <Table className="min-w-180">
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  {QUOTA_FIELDS.map((field) => (
                    <TableHead key={field.key}>{field.label}</TableHead>
                  ))}
                  <TableHead>用户数</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-2">
                        {item.name}
                        {item.isDefault ? (
                          <Badge variant="secondary">默认</Badge>
                        ) : null}
                      </span>
                    </TableCell>
                    {QUOTA_FIELDS.map((field) => (
                      <TableCell key={field.key}>
                        {formatQuotaValue(field.key, item[field.key])}
                      </TableCell>
                    ))}
                    <TableCell>{item.userCount}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          type="button"
                          onClick={() => setEditing(item)}
                        >
                          编辑
                        </Button>
                        {item.isDefault ? null : (
                          <Button
                            variant="outline"
                            type="button"
                            disabled={busy === item.id}
                            onClick={() => void remove(item)}
                          >
                            删除
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
          title={
            editing === "new" ? "新建额度配置" : `编辑额度配置 ${editing.name}`
          }
          onClose={() => setEditing(null)}
        >
          <ProfileForm
            item={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              void reload();
            }}
          />
        </Modal>
      ) : null}
    </main>
  );
}
