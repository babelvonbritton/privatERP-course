"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import { getStoredTheme, setTheme, type ThemeChoice } from "@/lib/theme";

const OPTIONS: ThemeChoice[] = ["light", "dark", "system"];

/** Theme picker: three radio options styled like the language picker. The stored choice is read after mount so the first render matches the server output. */
export function ThemeSection() {
  const { t } = useI18n();
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    setChoice(getStoredTheme());
  }, []);

  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <h2 className="text-base font-semibold text-plum-900">{t("settings.theme")}</h2>
      <p className="mt-1 text-sm text-muted">{t("settings.themeHint")}</p>
      <div className="mt-4 flex flex-wrap gap-2" role="radiogroup" aria-label={t("settings.theme")}>
        {OPTIONS.map((option) => {
          const current = option === choice;
          return (
            <label
              key={option}
              aria-current={current ? "true" : undefined}
              className={
                current
                  ? "inline-flex h-10 max-sm:h-11 cursor-pointer items-center justify-center gap-2 rounded-control bg-plum-100 px-4 text-sm font-medium text-plum-900 transition-colors duration-200"
                  : "inline-flex h-10 max-sm:h-11 cursor-pointer items-center justify-center gap-2 rounded-control border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors duration-200 hover:bg-plum-50"
              }
            >
              <input
                type="radio"
                name="theme"
                value={option}
                checked={current}
                onChange={() => {
                  setTheme(option);
                  setChoice(option);
                }}
                className="size-4 accent-plum-600"
              />
              {t(`theme.${option}`)}
            </label>
          );
        })}
      </div>
    </section>
  );
}
