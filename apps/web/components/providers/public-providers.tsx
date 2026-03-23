"use client";

import * as React from "react";
import { ToastProvider } from "@/components/providers/toast-provider";

export function PublicProviders({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
