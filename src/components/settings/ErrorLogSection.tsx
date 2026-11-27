"use client";

import { useState } from "react";
import { useI18n } from "@/i18n";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { exportErrorLog } from "@/lib/errors/errorLog";
import { useLoadOnce } from "@/lib/hooks/useLoadOnce";
import { getStorage } from "@/lib/storage";
import { getTimezone } from "@/lib/timezone";
import type { ErrorLogRecord } from "@/lib/domain/types";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";

/** Formats an ISO timestamp in the user's timezone and locale. */
function formatLogTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: getTimezone(), month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

/** One error row: when it happened, its code and action, and the message. */
function ErrorLogRow({ record, locale }: { record: ErrorLogRecord; locale: string }) {
  return (
    <li className="border-b border-line py-2 text-sm last:border-0 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-muted">{formatLogTime(record.time, locale)}</span>
        <span className="font-medium text-plum-900">{record.code}</span>
        <span className="text-muted">[{record.action}]</span>
      </div>
      {record.details && <p className="mt-0.5 break-words text-ink/80">{record.details}</p>}
    </li>
  );
}

/** Error log: the last 7 days of errors kept on this device, with export and clear. */
export function ErrorLogSection() {
  const { t, locale } = useI18n();
  const [count, setCount] = useState(0);
  const [entries, setEntries] = useState<ErrorLogRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);

  useLoadOnce(async (alive) => {
    const store = getStorage().errorLog;
    const [total, recent] = await Promise.all([store.count(), store.listRecent(10)]);
    if (alive()) {
      setCount(total);
      setEntries(recent);
    }
  }, "errorLog.load");

  async function reload(): Promise<void> {
    const store = getStorage().errorLog;
    const [total, recent] = await Promise.all([store.count(), store.listRecent(10)]);
    setCount(total);
    setEntries(recent);
  }

  async function runExport(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await exportErrorLog();
    } catch (e) {
      errorCenter.report(e, { action: "errorLog.export" });
    } finally {
      setBusy(false);
    }
  }

  async function confirmClear(): Promise<void> {
    setClearOpen(false);
    if (busy) return;
    setBusy(true);
    try {
      await getStorage().errorLog.clear();
      await reload();
      errorCenter.notify({ key: "toast.errorLogCleared" });
    } catch (e) {
      errorCenter.report(e, { action: "errorLog.clear" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <h2 className="text-base font-semibold text-plum-900">{t("settings.errorLog")}</h2>
      <p className="mt-1 text-sm text-muted">{t("settings.errorLogHint")}</p>
      <p className="mt-4 text-sm font-medium text-ink">{t("settings.errorLogCount", { count })}</p>
      {entries.length > 0 ? (
        <ul className="mt-2">
          {entries.map((record) => (
            <ErrorLogRow key={record.id} record={record} locale={locale} />
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">{t("settings.errorLogEmpty")}</p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="soft" icon="download" className="max-sm:h-11" disabled={busy || count === 0} onClick={() => void runExport()}>
          {t("settings.errorLogExport")}
        </Button>
        <Button variant="dangerSoft" className="max-sm:h-11" disabled={busy || count === 0} onClick={() => setClearOpen(true)}>
          {t("settings.errorLogClear")}
        </Button>
      </div>
      <ConfirmDialog
        open={clearOpen}
        title={t("settings.errorLogClearTitle")}
        body={t("settings.errorLogClearBody")}
        confirmLabel={t("settings.errorLogClearConfirm")}
        cancelLabel={t("action.cancel")}
        danger
        onConfirm={() => void confirmClear()}
        onCancel={() => setClearOpen(false)}
      />
    </section>
  );
}
