"use client";

import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";

type HiddenInput = {
  name: string;
  value: string;
};

export function PageSizeForm({
  action,
  pageSize,
  hiddenInputs,
  options = [10, 20, 50, 100, 200],
}: {
  action: string;
  pageSize: number;
  hiddenInputs?: HiddenInput[];
  options?: number[];
}) {
  const router = useRouter();

  return (
    <Select
      value={String(pageSize)}
      onValueChange={(value) => {
        const params = new URLSearchParams();
        for (const item of hiddenInputs ?? []) {
          params.set(item.name, item.value);
        }
        params.set("pageSize", value);
        const query = params.toString();
        router.push(query ? `${action}?${query}` : action);
      }}
    >
      <SelectTrigger
        className="h-9 min-w-20"
        aria-label="Select page size"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="start"
        sideOffset={4}
        className="w-(--radix-select-trigger-width)"
      >
        {options.map((value) => (
          <SelectItem key={value} value={String(value)}>
            {value}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
