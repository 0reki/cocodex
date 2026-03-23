"use client";

import { useEffect, useMemo, useState } from "react";
import type { MessageTargetMode, UserItem } from "@/lib/features/users/types/user-types";

export function useUserSelection(props: {
  items: UserItem[];
  currentUserId: string;
  messageTargetMode: MessageTargetMode;
}) {
  const { items, currentUserId, messageTargetMode } = props;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const filteredSelectableIds = useMemo(() => items.map((user) => user.id), [items]);
  const filteredSelectableIdSet = useMemo(
    () => new Set(filteredSelectableIds),
    [filteredSelectableIds],
  );
  const filteredManageableIdSet = useMemo(
    () =>
      new Set(
        items.filter((item) => item.id !== currentUserId).map((item) => item.id),
      ),
    [currentUserId, items],
  );
  const pageSelectableIds = useMemo(() => items.map((user) => user.id), [items]);
  const selectedRecipients = useMemo(
    () => items.filter((item) => filteredSelectableIdSet.has(item.id) && selectedIdSet.has(item.id)),
    [filteredSelectableIdSet, items, selectedIdSet],
  );
  const filteredRecipients = useMemo(
    () => items.filter((item) => filteredSelectableIdSet.has(item.id)),
    [filteredSelectableIdSet, items],
  );
  const selectedManageableRecipients = useMemo(
    () => items.filter((item) => filteredManageableIdSet.has(item.id) && selectedIdSet.has(item.id)),
    [filteredManageableIdSet, items, selectedIdSet],
  );

  const selectedCount = selectedRecipients.length;
  const selectedManageableCount = selectedManageableRecipients.length;
  const messageTargetRecipients =
    messageTargetMode === "filtered" ? filteredRecipients : selectedRecipients;
  const messageTargetCount = messageTargetRecipients.length;
  const canOpenMessageDialog = selectedRecipients.length > 0 || filteredRecipients.length > 0;
  const allChecked =
    pageSelectableIds.length > 0 && pageSelectableIds.every((id) => selectedIdSet.has(id));

  useEffect(() => {
    const visibleIds = new Set(items.map((item) => item.id));
    setSelectedIds((prev) => prev.filter((id) => visibleIds.has(id)));
  }, [items]);

  return {
    selectedIds,
    selectedIdSet,
    filteredSelectableIds,
    selectedRecipients,
    filteredRecipients,
    selectedManageableRecipients,
    selectedCount,
    selectedManageableCount,
    messageTargetRecipients,
    messageTargetCount,
    canOpenMessageDialog,
    allChecked,
    clearSelection: () => setSelectedIds([]),
    replaceSelection: (ids: string[]) => setSelectedIds(ids),
    toggleRowSelected: (id: string, checked: boolean) => {
      setSelectedIds((prev) => {
        if (checked) return [...new Set([...prev, id])];
        return prev.filter((item) => item !== id);
      });
    },
    toggleAll: (checked: boolean) => {
      if (checked) {
        setSelectedIds((prev) => Array.from(new Set([...prev, ...pageSelectableIds])));
        return;
      }
      setSelectedIds((prev) => prev.filter((id) => !pageSelectableIds.includes(id)));
    },
    selectFiltered: () => setSelectedIds(filteredSelectableIds),
  };
}
