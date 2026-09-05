import { createPortal } from "react-dom";

import { cn } from "@/ui/lib/utils";
import { LoaderIcon } from "lucide-react";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <LoaderIcon
      role="status"
      aria-label="正在加载"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

function FullScreenSpinner({ label = "正在加载" }: { label?: string }) {
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/60 text-muted-foreground backdrop-blur-[1px]"
      role="status"
      aria-label={label}
    >
      <Spinner role="presentation" aria-label={undefined} aria-hidden="true" />
    </div>,
    document.body,
  );
}

export { Spinner, FullScreenSpinner };
