"use client";

import * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon, MenuIcon } from "lucide-react";

import { cn } from "@workspace/ui/lib/utils";

type SidebarContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function useSidebar() {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) {
    throw new Error("useSidebar must be used within SidebarProvider");
  }
  return ctx;
}

type SidebarProviderProps = React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  className,
  children,
  ...props
}: SidebarProviderProps) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const [openMobile, setOpenMobile] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = React.useCallback(
    (value: boolean) => {
      if (onOpenChange) {
        onOpenChange(value);
      } else {
        setInternalOpen(value);
      }
    },
    [onOpenChange],
  );

  React.useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const toggleSidebar = React.useCallback(() => {
    if (isMobile) {
      setOpenMobile((prev) => !prev);
    } else {
      setOpen(!open);
    }
  }, [isMobile, open, setOpen]);

  const value = React.useMemo(
    () => ({
      open,
      setOpen,
      openMobile,
      setOpenMobile,
      isMobile,
      toggleSidebar,
    }),
    [open, setOpen, openMobile, isMobile, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        data-state={open ? "expanded" : "collapsed"}
        className={cn(
          "group/sidebar-wrapper flex w-full overflow-x-hidden",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

type SidebarProps = React.ComponentProps<"aside"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
};

function Sidebar({
  side = "left",
  className,
  children,
  ...props
}: SidebarProps) {
  const { open, openMobile, setOpenMobile } = useSidebar();

  return (
    <>
      <div
        data-slot="sidebar-gap"
        className={cn(
          "hidden shrink-0 md:block motion-safe:transition-[width] motion-safe:duration-200 motion-safe:ease-out",
          open ? "w-64" : "w-14",
        )}
      />
      <aside
        data-slot="sidebar"
        data-side={side}
        className={cn(
          "group/sidebar fixed inset-y-0 left-0 z-40 hidden overflow-visible border-r bg-background motion-safe:transition-[width] motion-safe:duration-200 motion-safe:ease-out md:block",
          open ? "w-64" : "w-14",
          className,
        )}
        {...props}
      >
        <div className="flex h-full flex-col overflow-hidden">{children}</div>
      </aside>

      <div className={cn("md:hidden", openMobile ? "block" : "hidden")}>
        <button
          aria-label="Close sidebar"
          className="fixed inset-0 z-40 bg-black/35"
          onClick={() => setOpenMobile(false)}
          type="button"
        />
        <aside
          data-slot="sidebar-mobile"
          className="fixed inset-y-0 left-0 z-50 w-72 border-r bg-background"
        >
          <div className="flex h-full flex-col">{children}</div>
        </aside>
      </div>
    </>
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn("relative flex min-w-0 flex-1 flex-col", className)}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn("p-2", className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-auto p-2",
        className,
      )}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn("border-t p-2", className)}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      className={cn("space-y-1", className)}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn("space-y-1", className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      className={cn("", className)}
      {...props}
    />
  );
}

type SidebarMenuButtonProps = React.ComponentProps<"button"> & {
  isActive?: boolean;
  tooltip?: string;
};

function SidebarMenuButton({
  isActive = false,
  tooltip,
  className,
  ...props
}: SidebarMenuButtonProps) {
  void tooltip;
  return (
    <button
      data-slot="sidebar-menu-button"
      data-active={isActive ? "true" : "false"}
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
        isActive
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function SidebarTrigger({
  className,
  ...props
}: React.ComponentProps<"button">) {
  const { onClick, ...rest } = props;
  const { toggleSidebar } = useSidebar();
  return (
    <button
      type="button"
      data-slot="sidebar-trigger"
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-md bg-transparent text-foreground/70 transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...rest}
    >
      <MenuIcon className="h-4 w-4" />
      <span className="sr-only">Toggle Sidebar</span>
    </button>
  );
}

function SidebarRail({ className, ...props }: React.ComponentProps<"button">) {
  const { open, toggleSidebar } = useSidebar();
  return (
    <button
      type="button"
      aria-label="Toggle Sidebar"
      data-slot="sidebar-rail"
      className={cn(
        "absolute left-[calc(100%+0.5px)] top-1/2 z-50 hidden h-20 w-4 -translate-y-1/2 items-center justify-center rounded-r-xl border border-l-0 bg-background text-muted-foreground opacity-0 shadow-sm transition-[opacity,color,background-color] duration-150 hover:bg-muted hover:opacity-100 focus-visible:opacity-100 md:inline-flex group-hover/sidebar:opacity-100 after:absolute after:-inset-x-3 after:-inset-y-2 after:content-['']",
        className,
      )}
      onClick={toggleSidebar}
      {...props}
    >
      {open ? (
        <ChevronLeftIcon className="h-4 w-4" />
      ) : (
        <ChevronRightIcon className="h-4 w-4" />
      )}
    </button>
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
};
