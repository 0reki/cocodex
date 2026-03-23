"use client";

import { useCallback, useEffect, useState } from "react";
import type { LocaleKey } from "@/locales";
import type { ApiKeyRecord } from "@/lib/features/api-keys/types/api-key-types";
import {
  createApiKey,
  deleteApiKey,
  listApiKeys,
  updateApiKey,
} from "@/lib/features/api-keys/api/api-key-api";

export function useApiKeys(props: {
  t: (key: LocaleKey) => string;
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
  };
}) {
  const { t, toast } = props;
  const [items, setItems] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [quota, setQuota] = useState("");
  const [expiresAt, setExpiresAt] = useState<Date | undefined>(undefined);
  const [unlimitedQuota, setUnlimitedQuota] = useState(true);
  const [noExpiry, setNoExpiry] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingQuota, setEditingQuota] = useState("");
  const [editingExpiresAt, setEditingExpiresAt] = useState<Date | undefined>(undefined);
  const [editingUnlimitedQuota, setEditingUnlimitedQuota] = useState(false);
  const [editingNoExpiry, setEditingNoExpiry] = useState(false);
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listApiKeys());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const createKey = async () => {
    const quotaValue =
      unlimitedQuota
        ? null
        : quota.trim().length > 0 && Number.isFinite(Number(quota)) && Number(quota) >= 0
          ? Number(quota)
          : NaN;
    const expiresAtIso = noExpiry ? null : expiresAt ? expiresAt.toISOString() : "";
    const payload = {
      name: name.trim(),
      quota: quotaValue,
      expiresAt: expiresAtIso,
    };
    if (!payload.name) {
      toast.info(t("apiKeys.nameRequired"));
      return;
    }
    if (
      !unlimitedQuota &&
      (!Number.isFinite(payload.quota as number) || (payload.quota as number) < 0)
    ) {
      return;
    }
    if (!noExpiry && !payload.expiresAt) {
      return;
    }

    setCreating(true);
    try {
      const item = await createApiKey(payload);
      setItems((prev) => [item, ...prev]);
      setName("");
      setQuota("");
      setExpiresAt(undefined);
      setUnlimitedQuota(true);
      setNoExpiry(true);
      setAddOpen(false);
      toast.success(t("apiKeys.created"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };

  const removeKey = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteApiKey(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
      toast.success(t("apiKeys.removed"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingId(null);
    }
  };

  const openEdit = (item: ApiKeyRecord) => {
    setEditingId(item.id);
    setEditingName(item.name);
    setEditingQuota(item.quota == null || !Number.isFinite(item.quota) ? "" : String(item.quota));
    setEditingUnlimitedQuota(item.quota == null);
    setEditingExpiresAt(
      item.expiresAt && !Number.isNaN(Date.parse(item.expiresAt))
        ? new Date(item.expiresAt)
        : undefined,
    );
    setEditingNoExpiry(item.expiresAt == null);
    setEditOpen(true);
  };

  const updateKey = async () => {
    if (!editingId) return;
    const payload = {
      name: editingName.trim(),
      quota:
        editingUnlimitedQuota
          ? null
          : editingQuota.trim().length > 0 &&
              Number.isFinite(Number(editingQuota)) &&
              Number(editingQuota) >= 0
            ? Number(editingQuota)
            : null,
      expiresAt: editingNoExpiry ? null : editingExpiresAt ? editingExpiresAt.toISOString() : null,
    };
    if (!payload.name) {
      toast.info(t("apiKeys.nameRequired"));
      return;
    }
    if (
      !editingUnlimitedQuota &&
      (payload.quota == null || !Number.isFinite(Number(payload.quota)))
    ) {
      return;
    }
    if (!editingNoExpiry && !payload.expiresAt) {
      return;
    }

    setUpdating(true);
    try {
      const item = await updateApiKey(editingId, payload);
      setItems((prev) => prev.map((current) => (current.id === item.id ? item : current)));
      setEditOpen(false);
      setEditingId(null);
      toast.success(t("apiKeys.updated"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdating(false);
    }
  };

  return {
    items,
    loading,
    addOpen,
    name,
    quota,
    expiresAt,
    unlimitedQuota,
    noExpiry,
    creating,
    deletingId,
    editOpen,
    editingId,
    editingName,
    editingQuota,
    editingExpiresAt,
    editingUnlimitedQuota,
    editingNoExpiry,
    updating,
    setAddOpen,
    setName,
    setQuota,
    setExpiresAt,
    setUnlimitedQuota,
    setNoExpiry,
    setEditOpen,
    setEditingName,
    setEditingQuota,
    setEditingExpiresAt,
    setEditingUnlimitedQuota,
    setEditingNoExpiry,
    createKey,
    removeKey,
    openEdit,
    updateKey,
  };
}
