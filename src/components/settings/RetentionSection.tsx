"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import { getServices } from "@/lib/domain/services";
import { errorCenter } from "@/lib/errors/ErrorCenter";

/** Trash retention setting: how long deleted records stay in the trash bin before they are removed for good. */
export function RetentionSection() {
  const { t } = useI18n();
  const [days, setDays] = useState<7 | 30>(7);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getServices()
      .trash.getRetentionDays()
      .then((value) => {
        if (!cancelled) setDays(value);
      })
      .catch((e) => errorCenter.report(e, { action: "trash.retention.load" }));
    return () => {
      cancelled = true;
    };
  }, []);

  async function choose(next: 7 | 30): Promise<void> {
    if (next === days || busy) return;
    setBusy(true);
    try {
      await getServices().trash.setRetentionDays(next);
      setDays(next);
    } catch (e) {
      errorCenter.report(e, { action: "trash.retention.save" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <h2 className="text-base font-semibold text-plum-900">{t("trash.retention")}</h2>
      <p className="mt-1 text-sm text-muted">{t("trash.retentionHint")}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {([7, 30] as const).map((option) => {
          const isCurrent = option === days;
          return (
            <button
              key={option}
              type="button"
              disabled={busy}
              aria-current={isCurrent ? "true" : undefined}
              onClick={() => void choose(option)}
              className={
                isCurrent
                  ? "inline-flex h-10 max-sm:h-11 items-center justify-center rounded-control bg-plum-100 px-4 text-sm font-medium text-plum-900 transition-colors duration-200 disabled:cursor-not-allowed"
                  : "inline-flex h-10 max-sm:h-11 items-center justify-center rounded-control border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors duration-200 hover:bg-plum-50 disabled:cursor-not-allowed"
              }
            >
              {t("trash.days", { count: option })}
            </button>
          );
        })}
      </div>
    </section>
  );
}
