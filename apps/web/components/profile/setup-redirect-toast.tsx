"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/providers/toast-provider";
import { useLocale } from "@/components/providers/locale-provider";

export function SetupRedirectToast({
  show,
}: {
  show: boolean;
}) {
  const toast = useToast();
  const { t } = useLocale();
  const router = useRouter();
  const shownRef = useRef(false);

  useEffect(() => {
    if (!show || shownRef.current) return;
    shownRef.current = true;
    toast.info(t("setup.completeProfileHint"));
    router.replace("/setup");
  }, [router, show, t, toast]);

  return null;
}

