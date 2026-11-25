"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import { LOCALE_NAMES, type Locale } from "@/i18n/routing";
import { setCurrency, subscribeCurrency } from "@/lib/currency";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { getServices, applyBusinessProfile } from "@/lib/domain/services";
import { startDriveSync } from "@/lib/driveSync";
import { getStorage } from "@/lib/storage";
import { Logo } from "./Logo";
import { TourProvider } from "./Tour";
import { LegalFooter } from "./legal/LegalFooter";
import { MOBILE_NAV_IDS, MORE_NAV_IDS, NAV_ITEMS, type NavId } from "./nav";
import { AttendanceScreen } from "./screens/AttendanceScreen";
import { CoursesScreen } from "./screens/CoursesScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { InvoicesScreen } from "./screens/InvoicesScreen";
import { MembersScreen } from "./screens/MembersScreen";
import { PayrollScreen } from "./screens/PayrollScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { TrainersScreen } from "./screens/TrainersScreen";
import { TrashScreen } from "./screens/TrashScreen";
import { Button } from "./ui/Button";
import { Icon } from "./ui/Icon";
import { Modal } from "./ui/Modal";

/** The app shell: sidebar on desktop, bottom bar on a phone, one screen at a time. */
export function AppShell() {
  const { t, localeCode } = useI18n();
  const [nav, setNav] = useState<NavId>("dashboard");
  const [moreOpen, setMoreOpen] = useState(false);
  const [, setCurrencyTick] = useState(0);

  // Loads the stored currency at boot so amounts format in it, and re-renders
  // every screen when a switch or a restore changes it. Expired trash entries
  // are purged on boot too, so the bin never shows items past their time.
  // Drive auto-sync also starts here: it listens for data changes for the
  // whole session and uploads only while Drive is connected and the toggle
  // is on.
  useEffect(() => {
    const stopSync = startDriveSync();
    let cancelled = false;
    void getStorage()
      .preferences.load()
      .then(({ preferences }) => {
        if (!cancelled) setCurrency(preferences.currency);
      })
      .catch((e) => errorCenter.report(e, { action: "currency.load" }));
    // New records are stamped with the business and owner names from the
    // profile, so the shared services take the stored profile's actor at
    // boot; saving the profile re-applies it without a restart.
    void getStorage()
      .profile.load()
      .then(({ profile }) => {
        if (!cancelled) applyBusinessProfile(profile);
      })
      .catch((e) => errorCenter.report(e, { action: "profile.load" }));
    void getServices()
      .trash.purgeExpired()
      .catch((e) => errorCenter.report(e, { action: "trash.purge" }));
    const stopCurrency = subscribeCurrency(() => setCurrencyTick((n) => n + 1));
    return () => {
      stopSync();
      stopCurrency();
    };
  }, []);

  const navigate = useCallback((id: NavId) => {
    setNav(id);
    setMoreOpen(false);
    window.scrollTo({ top: 0 });
  }, []);

  const otherLocale: Locale = localeCode === "en" ? "id" : "en";

  return (
    <TourProvider navigate={navigate}>
      <div className="min-h-dvh bg-canvas text-ink">
        {/* Desktop sidebar */}
        <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-line bg-surface md:flex">
          <div className="px-5 pb-2 pt-5">
            <Logo />
          </div>
          <nav aria-label={t("nav.dashboard")} className="flex-1 overflow-y-auto px-3 py-4">
            <ul className="flex flex-col gap-0.5">
              {NAV_ITEMS.map((item) => {
                const active = nav === item.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => navigate(item.id)}
                      className={`flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-sm transition-colors duration-200 ${active ? "bg-plum-100 font-medium text-plum-900" : "text-ink/80 hover:bg-plum-50 hover:text-ink"}`}
                    >
                      <Icon name={item.icon} size={18} />
                      {t(item.labelKey)}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="border-t border-line px-3 py-3">
            <Link href={`/${otherLocale}/`} className="flex items-center gap-3 rounded-control px-3 py-2 text-sm text-muted transition-colors hover:bg-plum-50 hover:text-ink">
              <Icon name="globe" size={18} />
              {LOCALE_NAMES[otherLocale]}
            </Link>
          </div>
        </aside>

        {/* Mobile top bar */}
        <header className="fixed inset-x-0 top-0 z-30 flex items-center justify-between border-b border-line bg-surface px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top,0px))] md:hidden">
          <Logo small />
        </header>

        <div className="md:pl-60">
          <main className="mx-auto w-full max-w-5xl px-4 pb-28 pt-[calc(4.25rem+env(safe-area-inset-top,0px))] md:px-8 md:pb-10 md:pt-6">
            {nav === "dashboard" && <DashboardScreen navigate={navigate} />}
            {nav === "members" && <MembersScreen navigate={navigate} />}
            {nav === "trainers" && <TrainersScreen navigate={navigate} />}
            {nav === "courses" && <CoursesScreen navigate={navigate} />}
            {nav === "attendance" && <AttendanceScreen navigate={navigate} />}
            {nav === "invoices" && <InvoicesScreen navigate={navigate} />}
            {nav === "payroll" && <PayrollScreen navigate={navigate} />}
            {nav === "trash" && <TrashScreen navigate={navigate} />}
            {nav === "settings" && <SettingsScreen navigate={navigate} />}
          </main>
          <LegalFooter className="mx-auto w-full max-w-5xl md:px-8" />
        </div>

        {/* Mobile bottom bar */}
        <nav aria-label={t("nav.dashboard")} className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
          <ul className="grid grid-cols-5">
            {MOBILE_NAV_IDS.map((id) => {
              const item = NAV_ITEMS.find((n) => n.id === id)!;
              const active = nav === id;
              return (
                <li key={id}>
                  <button
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => navigate(id)}
                    className={`flex w-full flex-col items-center gap-0.5 py-2 text-[11px] transition-colors ${active ? "font-medium text-plum-600" : "text-muted hover:text-ink"}`}
                  >
                    <Icon name={item.icon} size={20} />
                    {t(item.labelKey)}
                  </button>
                </li>
              );
            })}
            <li>
              <button
                type="button"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen(true)}
                className={`flex w-full flex-col items-center gap-0.5 py-2 text-[11px] transition-colors ${MORE_NAV_IDS.includes(nav) ? "font-medium text-plum-600" : "text-muted hover:text-ink"}`}
              >
                <Icon name="dots" size={20} />
                {t("nav.more")}
              </button>
            </li>
          </ul>
        </nav>

        {/* More sheet on a phone */}
        <Modal open={moreOpen} onOpenChange={setMoreOpen} title={t("nav.more")}>
          <ul className="flex flex-col gap-0.5">
            {MORE_NAV_IDS.map((id) => {
              const item = NAV_ITEMS.find((n) => n.id === id)!;
              return (
                <li key={id}>
                  <button
                    type="button"
                    aria-current={nav === id ? "page" : undefined}
                    onClick={() => navigate(id)}
                    className={`flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-sm transition-colors ${nav === id ? "bg-plum-100 font-medium text-plum-900" : "text-ink/80 hover:bg-plum-50"}`}
                  >
                    <Icon name={item.icon} size={18} />
                    {t(item.labelKey)}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={() => setMoreOpen(false)}>
              {t("action.close")}
            </Button>
          </div>
        </Modal>
      </div>
    </TourProvider>
  );
}
