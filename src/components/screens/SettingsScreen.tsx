"use client";

import Link from "next/link";
import { useCallback, useState, type ReactNode } from "react";
import { useI18n } from "@/i18n";
import { LOCALES, LOCALE_NAMES } from "@/i18n/routing";
import { APP_VERSION } from "@/lib/appInfo";
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, DB_SCHEMA_VERSION } from "@/lib/backup/constants";
import { BackupDialog } from "../backup/BackupDialog";
import { GuideButton } from "../GuideButton";
import { BusinessProfileSection } from "../settings/BusinessProfileSection";
import { CurrencySection } from "../settings/CurrencySection";
import { DriveSection } from "../settings/DriveSection";
import { RetentionSection } from "../settings/RetentionSection";
import { ThemeSection } from "../settings/ThemeSection";
import { TimezoneSection } from "../settings/TimezoneSection";
import type { NavId } from "../nav";
import { useTour } from "../Tour";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

/** One settings group: a label, a short hint, and its controls. */
function SectionCard({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <h2 className="text-base font-semibold text-plum-900">{label}</h2>
      <p className="mt-1 text-sm text-muted">{hint}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** One row in the about list: a muted label on the left, a value on the right. */
function AboutRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 text-sm last:border-0 first:pt-0 last:pb-0">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium text-ink">{children}</dd>
    </div>
  );
}

/** Settings screen: language, theme, currency, backup and restore, tour replay, and app facts. */
export function SettingsScreen({ navigate: _navigate }: { navigate: (id: NavId) => void }) {
  const { t, localeCode } = useI18n();
  const { startTour } = useTour();
  const [guideOpen, setGuideOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);

  const reload = useCallback(async () => {}, []);

  return (
    <div data-tour="settings" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-plum-900">{t("settings.title")}</h1>
        <GuideButton section="settings" variant="bordered" open={guideOpen} onOpenChange={setGuideOpen} />
      </div>

      <BusinessProfileSection />

      <SectionCard label={t("settings.language")} hint={t("settings.languageHint")}>
        <div className="flex flex-wrap gap-2">
          {LOCALES.map((code) => {
            const current = code === localeCode;
            return (
              <Link
                key={code}
                href={`/${code}/`}
                aria-current={current ? "true" : undefined}
                className={
                  current
                    ? "inline-flex h-10 max-sm:h-11 items-center justify-center rounded-control bg-plum-100 px-4 text-sm font-medium text-plum-900 transition-colors duration-200"
                    : "inline-flex h-10 max-sm:h-11 items-center justify-center rounded-control border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors duration-200 hover:bg-plum-50"
                }
              >
                {LOCALE_NAMES[code]}
              </Link>
            );
          })}
        </div>
      </SectionCard>

      <ThemeSection />

      <TimezoneSection />

      <CurrencySection />

      <RetentionSection />

      <SectionCard label={t("settings.backup")} hint={t("settings.backupHint")}>
        <Button className="max-sm:h-11" onClick={() => setBackupOpen(true)}>{t("backup.title")}</Button>
        <BackupDialog
          open={backupOpen}
          onOpenChange={setBackupOpen}
          onRestored={reload}
          onHelp={() => setGuideOpen(true)}
        />
      </SectionCard>

      <DriveSection onRestored={reload} />

      <SectionCard label={t("settings.tour")} hint={t("settings.tourHint")}>
        <Button variant="soft" className="max-sm:h-11" onClick={() => startTour()}>
          {t("settings.tour")}
        </Button>
      </SectionCard>

      <section className="rounded-card border border-line bg-surface p-4">
        <h2 className="text-base font-semibold text-plum-900">{t("settings.about")}</h2>
        <dl className="mt-2">
          <AboutRow label={t("settings.appVersion")}>{APP_VERSION}</AboutRow>
          <AboutRow label={t("settings.backupFormat")}>
            {BACKUP_FORMAT} v{BACKUP_FORMAT_VERSION}
          </AboutRow>
          <AboutRow label={t("settings.schemaVersion")}>{String(DB_SCHEMA_VERSION)}</AboutRow>
          <AboutRow label={t("settings.license")}>{t("settings.licenseValue")}</AboutRow>
          <AboutRow label={t("settings.privacy")}>
            <Link href={`/${localeCode}/privacy/`} className="text-plum-600 transition-colors duration-200 hover:underline">
              {t("settings.privacy")}
            </Link>
          </AboutRow>
          <AboutRow label={t("settings.terms")}>
            <Link href={`/${localeCode}/terms/`} className="text-plum-600 transition-colors duration-200 hover:underline">
              {t("settings.terms")}
            </Link>
          </AboutRow>
        </dl>
      </section>
    </div>
  );
}
