import { PublicProviders } from "@/components/providers/public-providers";

export default function PublicLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <PublicProviders>{children}</PublicProviders>;
}
