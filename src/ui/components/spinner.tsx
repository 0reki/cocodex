import { createContext, useContext } from "react";
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

const LoadingContainerContext = createContext<HTMLElement | null>(null);

function ContentSpinner({ label = "正在加载" }: { label?: string }) {
  const container = useContext(LoadingContainerContext);
  if (!container) return null;
  return createPortal(
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/60 text-muted-foreground backdrop-blur-[1px]"
      role="status"
      aria-label={label}
    >
      <Spinner role="presentation" aria-label={undefined} aria-hidden="true" />
    </div>,
    container,
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

export { Spinner, ContentSpinner, FullScreenSpinner, LoadingContainerContext };
