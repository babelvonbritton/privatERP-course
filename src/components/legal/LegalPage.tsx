"use client";

import Link from "next/link";
import { useI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/types";
import { Logo } from "../Logo";
import { Icon } from "../ui/Icon";
import { LegalFooter } from "./LegalFooter";

/**
 * Shared shell for the legal pages: header with logo and back-to-app link,
 * a centered column with title, updated line, intro, and one section per
 * entry, and the legal footer.
 */
export function LegalPage({
  namespace,
  sections,
  updated,
  sectionId,
}: {
  namespace: string;
  sections: readonly string[];
  updated: Date;
  sectionId?: (section: string) => string | undefined;
}) {
  const { t, locale, localeCode } = useI18n();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 md:px-10">
        <Link href={`/${localeCode}/`}><Logo small /></Link>
        <Link href={`/${localeCode}/`} className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-plum-600">
          <Icon name="arrowLeft" size={15} />
          {t("legal.backToApp")}
        </Link>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-10">
        <h1 className="text-3xl font-semibold tracking-tight text-plum-900">{t(`${namespace}.title` as MessageKey)}</h1>
        <p className="mt-1 text-xs text-muted">{t(`${namespace}.updated` as MessageKey, { date: new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(updated) })}</p>
        <p className="mt-5 leading-relaxed text-ink/90">{t(`${namespace}.intro` as MessageKey)}</p>
        {sections.map((s) => (
          <section key={s} id={sectionId?.(s)} className="mt-8 scroll-mt-6">
            <h2 className="text-lg font-semibold text-plum-900">{t(`${namespace}.${s}.title` as MessageKey)}</h2>
            <p className="mt-2 leading-relaxed text-ink/90">{t(`${namespace}.${s}.body` as MessageKey)}</p>
          </section>
        ))}
      </main>
      <LegalFooter />
    </div>
  );
}
