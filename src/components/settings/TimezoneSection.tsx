"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { getTimezone, setTimezone, subscribeTimezone, timezones, zoneLabel } from "@/lib/timezone";
import { getStorage } from "@/lib/storage";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { useLoadOnce } from "@/lib/hooks/useLoadOnce";
import { Select } from "../ui/Select";

/**
 * Local timezone setting: the zone dates are derived in. It starts as the
 * device timezone and the user can change it anytime; every date in the app
 * follows the pick. No location is ever detected.
 */
export function TimezoneSection() {
  const { t } = useI18n();
  const [zone, setZone] = useState<string>(() => getTimezone());
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => {
    const zones = timezones();
    if (!zones.includes(zone)) zones.push(zone);
    return zones.map((value) => ({ value, label: zoneLabel(value) }));
  }, [zone]);

  useLoadOnce(async (alive) => {
    const { preferences } = await getStorage().preferences.load();
    if (alive()) setZone(preferences.timezone);
  }, "timezone.load");

  useEffect(() => subscribeTimezone(() => setZone(getTimezone())), []);

  async function choose(next: string): Promise<void> {
    if (next === zone || busy) return;
    setBusy(true);
    try {
      await getStorage().preferences.set("timezone", next);
      setTimezone(next);
      setZone(next);
    } catch (e) {
      errorCenter.report(e, { action: "timezone.save" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <h2 className="text-base font-semibold text-plum-900">{t("settings.timezone")}</h2>
      <p className="mt-1 text-sm text-muted">{t("settings.timezoneHint")}</p>
      <div className="mt-4">
        <Select value={zone} onChange={(v) => void choose(v)} options={options} ariaLabel={t("settings.timezone")} className="w-full max-w-full max-sm:h-11" scrollToSelectedOnOpen />
      </div>
    </section>
  );
}
