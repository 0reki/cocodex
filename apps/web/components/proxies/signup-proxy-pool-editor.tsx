"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/providers/toast-provider";
import { Checkbox } from "@workspace/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table";
import { Spinner } from "@workspace/ui/components/spinner";
import { useLocale } from "@/components/providers/locale-provider";

type ProxyListResponse = {
  items?: Array<{ id?: string; proxyUrl?: string }>;
};

export function SignupProxyPoolEditor() {
  const [rows, setRows] = useState<Array<{ id: string; proxyUrl: string }>>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addText, setAddText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const { t } = useLocale();

  const loadProxies = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/signup-proxies", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`Load proxies failed: HTTP ${res.status}`);
      }
      const data = (await res.json()) as ProxyListResponse;
      const nextRows = (data.items ?? []).map((item, index) => ({
        id: item.id?.trim() || `loaded-${index}-${Date.now()}`,
        proxyUrl: item.proxyUrl?.trim() ?? "",
      }));
      setRows(nextRows);
      setSelected({});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadProxies();
  }, [loadProxies]);

  const saveProxies = async () => {
    setSaving(true);
    try {
      const proxies = rows
        .map((item) => item.proxyUrl)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      const res = await fetch("/api/signup-proxies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxies }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Save proxies failed: ${text}`);
      }
      await loadProxies();
      toast.success(t("proxies.saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const addBulk = async (raw: string) => {
    const incoming = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (incoming.length === 0) return;

    const merged = Array.from(
      new Set([
        ...rows.map((item) => item.proxyUrl.trim()).filter((item) => item.length > 0),
        ...incoming,
      ]),
    );

    setSaving(true);
    try {
      const res = await fetch("/api/signup-proxies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxies: merged }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Add proxies failed: ${text}`);
      }
      setAddText("");
      setAddDialogOpen(false);
      await loadProxies();
      toast.success(t("proxies.added"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((item) => item.id !== id));
    setSelected((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const removeSelected = () => {
    const selectedIds = new Set(Object.keys(selected).filter((key) => selected[key]));
    if (selectedIds.size === 0) return;
    setRows((prev) => prev.filter((item) => !selectedIds.has(item.id)));
    setSelected({});
  };

  const updateRow = (id: string, proxyUrl: string) => {
    setRows((prev) =>
      prev.map((item) => (item.id === id ? { ...item, proxyUrl } : item)),
    );
  };

  const selectedCount = useMemo(
    () => rows.filter((item) => selected[item.id]).length,
    [rows, selected],
  );
  const allChecked = rows.length > 0 && selectedCount === rows.length;

  const toggleAll = (checked: boolean) => {
    if (!checked) {
      setSelected({});
      return;
    }
    const next: Record<string, boolean> = {};
    for (const row of rows) next[row.id] = true;
    setSelected(next);
  };

  const toggleOne = (id: string, checked: boolean) => {
    setSelected((prev) => {
      if (!checked) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: true };
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2 px-1 py-1">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={removeSelected}
            disabled={selectedCount === 0}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60"
          >
            {`${t("proxies.removeSelected")} (${selectedCount})`}
          </button>
          <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
            <DialogTrigger asChild>
              <button
                type="button"
                disabled={saving || loading}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60"
              >
                {t("common.add")}
              </button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("proxies.addProxies")}</DialogTitle>
                <DialogDescription>
                  {t("proxies.pastePerLine")}
                </DialogDescription>
              </DialogHeader>
              <textarea
                value={addText}
                onChange={(e) => setAddText(e.target.value)}
                rows={8}
                placeholder={t("proxies.proxyPlaceholder")}
                className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-xs"
              />
              <DialogFooter>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void addBulk(addText)}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60"
                >
                  {saving ? (
                    <span className="flex w-full justify-center">
                      <Spinner />
                    </span>
                  ) : (
                    t("common.add")
                  )}
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <button
            type="button"
            onClick={saveProxies}
            disabled={saving}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60"
          >
            {saving ? (
              <span className="flex w-full justify-center">
                <Spinner />
              </span>
            ) : (
              t("common.save")
            )}
          </button>
        </div>
      </div>

      <section className="overflow-x-auto rounded-lg border">
        <Table className="min-w-[820px]">
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="px-3 py-2">
                <Checkbox
                  checked={allChecked}
                  onCheckedChange={(checked) => toggleAll(checked === true)}
                  aria-label="Select all proxies"
                />
              </TableHead>
              <TableHead className="px-3 py-2">#</TableHead>
              <TableHead className="px-3 py-2">{t("proxies.proxyUrl")}</TableHead>
              <TableHead className="px-3 py-2 text-right">{t("accounts.action")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell className="px-3 py-3 text-muted-foreground" colSpan={4}>
                  {loading ? t("common.loading") : t("proxies.noProxies")}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row, index) => (
                <TableRow key={row.id} className="border-t">
                  <TableCell className="px-3 py-2">
                    <Checkbox
                      checked={Boolean(selected[row.id])}
                      onCheckedChange={(checked) => toggleOne(row.id, checked === true)}
                      aria-label={`Select proxy ${index + 1}`}
                    />
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs text-muted-foreground">
                    {index + 1}
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <input
                      value={row.proxyUrl}
                      onChange={(e) => updateRow(row.id, e.target.value)}
                      placeholder={t("proxies.proxyPlaceholder")}
                      className="h-9 w-full rounded-md border bg-background px-2 text-xs"
                    />
                  </TableCell>
                  <TableCell className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => removeRow(row.id)}
                      className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                    >
                      {t("common.remove")}
                    </button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
