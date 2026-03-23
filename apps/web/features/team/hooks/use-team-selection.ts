"use client";

import { useMemo, useState } from "react";
import type { TeamAccountRecord } from "@workspace/database";

export function useTeamSelection(items: TeamAccountRecord[]) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const selectedEmails = useMemo(
    () => items.filter((item) => selected[item.email]).map((item) => item.email),
    [items, selected],
  );
  const allChecked = items.length > 0 && selectedEmails.length === items.length;

  return {
    selected,
    selectedEmails,
    allChecked,
    clearSelection: () => setSelected({}),
    toggleAll: (checked: boolean) => {
      if (!checked) {
        setSelected({});
        return;
      }
      const next: Record<string, boolean> = {};
      for (const item of items) {
        next[item.email] = true;
      }
      setSelected(next);
    },
    toggleOne: (email: string, checked: boolean) => {
      setSelected((prev) => {
        if (!checked) {
          const next = { ...prev };
          delete next[email];
          return next;
        }
        return { ...prev, [email]: true };
      });
    },
  };
}
