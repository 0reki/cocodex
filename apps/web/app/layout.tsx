import type { Metadata } from "next";
import { Google_Sans, Roboto_Mono } from "next/font/google";

import "@workspace/ui/globals.css";

const fontSans = Google_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
});

const fontMono = Roboto_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "CoCodex",
  icons: {
    icon: "/codex-shell-logo.svg",
    shortcut: "/codex-shell-logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${fontSans.variable} ${fontMono.variable} font-sans antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
