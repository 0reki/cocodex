"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Spinner } from "@workspace/ui/components/spinner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { useToast } from "@/components/providers/toast-provider";
import { useLocale } from "@/components/providers/locale-provider";
import {
  getCountryOptions,
  getLocaleFromCountry,
  isCountryCode,
} from "@/lib/i18n/locale-map";

type ProfileEditorProps = {
  profile: {
    username: string;
    country: string | null;
    mustSetup: boolean;
  };
};

export function ProfileEditor({ profile }: ProfileEditorProps) {
  const { t, locale, setLocale } = useLocale();
  const toast = useToast();
  const router = useRouter();
  const [country, setCountry] = useState(() => {
    const initialCountry = profile.country;
    return isCountryCode(initialCountry) ? initialCountry.toUpperCase() : "CN";
  });
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingCountry, setSavingCountry] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [setupPassword, setSetupPassword] = useState("");
  const countryOptions = useMemo(() => getCountryOptions(locale), [locale]);

  const saveCountry = async () => {
    setSavingCountry(true);
    try {
      const res = await fetch("/api/admin/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ country }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? t("profile.updateFailed"));
        return;
      }

      toast.success(t("profile.updateSuccess"));
      const nextLocale = getLocaleFromCountry(country);
      if (nextLocale !== locale) {
        setLocale(nextLocale);
      } else {
        router.refresh();
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("profile.updateFailed"),
      );
    } finally {
      setSavingCountry(false);
    }
  };

  const savePassword = async () => {
    if (!currentPassword || newPassword.length < 8) return;
    setSavingPassword(true);
    try {
      const res = await fetch("/api/admin/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? t("profile.updateFailed"));
        return;
      }

      toast.success(t("profile.passwordUpdated"));
      setCurrentPassword("");
      setNewPassword("");
      setPasswordDialogOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("profile.updateFailed"),
      );
    } finally {
      setSavingPassword(false);
    }
  };

  const completeSetup = async () => {
    if (!country || setupPassword.length < 8) return;
    setSavingCountry(true);
    setSavingPassword(true);
    try {
      const res = await fetch("/api/admin/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          country,
          newPassword: setupPassword,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? t("profile.updateFailed"));
        return;
      }

      toast.success(t("profile.updateSuccess"));
      const nextLocale = getLocaleFromCountry(country);
      if (nextLocale !== locale) {
        setLocale(nextLocale);
      } else {
        router.refresh();
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("profile.updateFailed"),
      );
    } finally {
      setSavingCountry(false);
      setSavingPassword(false);
    }
  };

  return (
    <section className="bg-background">
      <div>
        <div className="py-4">
          <label className="mb-2 block text-base font-semibold">
            {t("users.username")}
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <Input value={profile.username} disabled className="h-10 flex-1" />
            {profile.mustSetup ? null : (
              <Dialog
                open={passwordDialogOpen}
                onOpenChange={setPasswordDialogOpen}
              >
                <DialogTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10! w-full shrink-0 px-3 text-sm sm:w-auto"
                  >
                    {t("profile.changePassword")}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{t("profile.changePassword")}</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <label className="block text-sm font-medium">
                        {t("profile.currentPassword")}
                      </label>
                      <Input
                        type="password"
                        className="h-10"
                        placeholder={t("profile.currentPasswordPlaceholder")}
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="block text-sm font-medium">
                        {t("profile.newPassword")}
                      </label>
                      <Input
                        type="password"
                        className="h-10"
                        placeholder={t("profile.newPasswordPlaceholder")}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      type="button"
                      onClick={savePassword}
                      disabled={
                        savingPassword ||
                        !currentPassword ||
                        newPassword.length < 8
                      }
                    >
                      {savingPassword ? <Spinner className="size-4" /> : t("common.save")}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </div>
        </div>

        <div className="py-4">
          <label className="mb-2 block text-base font-semibold">
            {t("profile.countryRegion")}
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <Select value={country} onValueChange={setCountry}>
              <SelectTrigger className="h-10! w-full">
                <SelectValue placeholder={t("profile.countryPlaceholder")} />
              </SelectTrigger>
              <SelectContent
                position="popper"
                align="start"
                className="w-(--radix-select-trigger-width)"
              >
                {countryOptions.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              onClick={profile.mustSetup ? completeSetup : saveCountry}
              disabled={
                savingCountry ||
                !country ||
                (profile.mustSetup && setupPassword.length < 8)
              }
              className="h-10! min-w-22 w-full shrink-0 px-3 text-sm sm:w-auto"
            >
              {savingCountry ? <Spinner className="size-4" /> : t("common.save")}
            </Button>
          </div>
        </div>

        {profile.mustSetup ? (
          <div className="py-4">
            <label className="mb-2 block text-base font-semibold">
              {t("profile.newPassword")}
            </label>
            <Input
              type="password"
              className="h-10"
              placeholder={t("profile.newPasswordPlaceholder")}
              value={setupPassword}
              onChange={(e) => setSetupPassword(e.target.value)}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
