import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { LOCALE_BOOT_SCRIPT, LocaleProvider } from "@/i18n/locale";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "HealTrip - AI Patient Decision Assistant",
  description:
    "Prototype assistant that helps a patient decide whether to see a specialist, go to the ER, or seek a second opinion.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // `lang`/`dir` are rewritten before first paint by the boot script below, so
    // React must not treat the server-rendered defaults as a mismatch.
    <html
      lang="en"
      dir="ltr"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: LOCALE_BOOT_SCRIPT }} />
      </head>
      {/* `h-full` (not `min-h-full`) bounds the page so the message list, not the
          document, is the scroll container (see ChatWindow). */}
      <body className="flex h-full flex-col bg-zinc-50 text-zinc-900">
        <LocaleProvider>{children}</LocaleProvider>
      </body>
    </html>
  );
}
