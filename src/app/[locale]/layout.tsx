import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { GlobalErrorHandlers } from "@/components/GlobalErrorHandlers";
import { ThemeSync } from "@/components/ThemeSync";
import { Toaster } from "@/components/Toaster";
import { isLocale, LOCALES, LOCALE_TAGS } from "@/i18n/routing";
import "../globals.css";

export const dynamicParams = false;

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

/**
 * Content Security Policy for static hosting (a meta tag, because GitHub Pages cannot send headers).
 * Applied in production only; the dev server needs looser rules for hot reload.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://api.frankfurter.dev https://api.exchangerate-api.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

async function loadMessages(locale: string) {
  return (await import(`../../../messages/${locale}.json`)).default;
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const messages = await loadMessages(locale);
  return {
    title: "Olaseena",
    description: messages.app.tagline,
    referrer: "no-referrer",
    alternates: { languages: Object.fromEntries(LOCALES.map((l) => [LOCALE_TAGS[l], `/${l}/`])) },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f5f0" },
    { media: "(prefers-color-scheme: dark)", color: "#1e151f" },
  ],
};

/**
 * Runs before first paint so the stored theme applies without a flash: reads
 * the "olaseena.theme" preference and toggles the dark class on <html>.
 * Plain script, no module or defer; the CSP allows inline scripts. The class
 * it adds differs from the server output, so <html> carries
 * suppressHydrationWarning for that expected difference.
 */
const THEME_SCRIPT =
  'try{var t=localStorage.getItem("olaseena.theme");var d=t==="dark"||(t!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}';

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale); // keeps the page statically rendered
  const messages = await loadMessages(locale);
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {process.env.NODE_ENV === "production" && <meta httpEquiv="Content-Security-Policy" content={CSP} />}
      </head>
      <body>
        <ThemeSync />
        <GlobalErrorHandlers />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ErrorBoundary>{children}</ErrorBoundary>
          <Toaster />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
