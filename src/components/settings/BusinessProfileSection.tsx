"use client";

import { useI18n } from "@/i18n";
import { BusinessProfileForm } from "../profile/BusinessProfileForm";

/** Business profile section: the first thing in Settings, editable any time. */
export function BusinessProfileSection() {
  const { t } = useI18n();
  return (
    <section data-tour="profile" className="rounded-card border border-line bg-surface p-4">
      <h2 className="text-base font-semibold text-plum-900">{t("profile.title")}</h2>
      <p className="mt-1 text-sm text-muted">{t("profile.hint")}</p>
      <div className="mt-4">
        <BusinessProfileForm />
      </div>
    </section>
  );
}
