"use client";

import { useToast } from "@/components/providers/toast-provider";
import { Button } from "@workspace/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table";
import { useLocale } from "@/components/providers/locale-provider";
import { ApiKeyDialog } from "../components/api-key-dialog";
import { ApiKeyRow } from "../components/api-key-row";
import { useApiKeys } from "../hooks/use-api-keys";

export function ApiKeysEditor() {
  const toast = useToast();
  const { t, locale } = useLocale();
  const {
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
  } = useApiKeys({
    t,
    toast,
  });

  return (
    <section className="bg-background">
      <div className="mb-3 flex items-center justify-end">
        <Button size="lg" onClick={() => setAddOpen(true)}>
          {t("apiKeys.addApiKey")}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table className="min-w-[980px]">
          <TableHeader>
            <TableRow>
              <TableHead className="px-3 py-2.5 text-sm">{t("common.name")}</TableHead>
              <TableHead className="px-3 py-2.5 text-sm">{t("apiKeys.apiKey")}</TableHead>
              <TableHead className="px-3 py-2.5 text-sm">{t("apiKeys.usage")}</TableHead>
              <TableHead className="px-3 py-2.5 text-sm">{t("apiKeys.expiresAt")}</TableHead>
              <TableHead className="px-3 py-2.5 text-sm">{t("common.updatedAt")}</TableHead>
              <TableHead className="px-3 py-2.5 text-right text-sm">
                {t("common.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell
                  className="px-3 py-3 text-sm text-muted-foreground"
                  colSpan={6}
                >
                  {loading ? t("common.loading") : t("apiKeys.noApiKeys")}
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <ApiKeyRow
                  key={item.id}
                  item={item}
                  locale={locale}
                  deletingId={deletingId}
                  updating={updating}
                  t={t}
                  onEdit={() => openEdit(item)}
                  onRemove={() => void removeKey(item.id)}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <ApiKeyDialog
        open={addOpen}
        title={t("apiKeys.addApiKey")}
        name={name}
        quota={quota}
        expiresAt={expiresAt}
        unlimitedQuota={unlimitedQuota}
        noExpiry={noExpiry}
        busy={creating}
        locale={locale}
        t={t}
        submitLabel={t("common.add")}
        onOpenChange={setAddOpen}
        onNameChange={setName}
        onQuotaChange={setQuota}
        onExpiresAtChange={setExpiresAt}
        onUnlimitedQuotaChange={setUnlimitedQuota}
        onNoExpiryChange={setNoExpiry}
        onSubmit={() => void createKey()}
      />

      <ApiKeyDialog
        open={editOpen}
        title={t("apiKeys.editApiKey")}
        name={editingName}
        quota={editingQuota}
        expiresAt={editingExpiresAt}
        unlimitedQuota={editingUnlimitedQuota}
        noExpiry={editingNoExpiry}
        busy={updating}
        locale={locale}
        t={t}
        submitLabel={t("common.save")}
        clearExpiry
        onOpenChange={setEditOpen}
        onNameChange={setEditingName}
        onQuotaChange={setEditingQuota}
        onExpiresAtChange={setEditingExpiresAt}
        onUnlimitedQuotaChange={setEditingUnlimitedQuota}
        onNoExpiryChange={setEditingNoExpiry}
        onSubmit={() => void updateKey()}
      />
    </section>
  );
}
