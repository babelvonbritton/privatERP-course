import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import en from "../messages/en.json";
import id from "../messages/id.json";

const ALL = { en, id } as const;

/** Wraps a component the way the locale layout does in the real app. */
export function Providers({ children, locale = "en" }: { children: ReactNode; locale?: keyof typeof ALL }) {
  return (
    <NextIntlClientProvider locale={locale} messages={ALL[locale]}>
      {children}
    </NextIntlClientProvider>
  );
}
