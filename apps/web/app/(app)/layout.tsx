import { AppShell } from "@/components/layout/app-shell";
import { LogoLoadingOverlay } from "@/components/layout/logo-loading-overlay";
import { Providers } from "@/components/providers/providers";

export default function PrivateAppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <Providers>
      <LogoLoadingOverlay />
      <AppShell>{children}</AppShell>
    </Providers>
  );
}
