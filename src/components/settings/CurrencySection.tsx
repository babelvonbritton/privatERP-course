"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import { getCurrency, subscribeCurrency } from "@/lib/currency";
import { CURRENCIES, type CurrencyCode } from "@/lib/domain/types";
import { getServices } from "@/lib/domain/services";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { getStorage } from "@/lib/storage";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Modal } from "../ui/Modal";

/** Currency settings: pick IDR, EUR or USD, confirm, and every amount converts at today's live rate. */
export function CurrencySection() {
  const { t } = useI18n();
  const [current, setCurrent] = useState<CurrencyCode>(() => getCurrency());
  const [pending, setPending] = useState<CurrencyCode | null>(null);
  const [remaining, setRemaining] = useState(10);
  const [dialog, setDialog] = useState<"confirm" | "limit" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getStorage()
      .preferences.load()
      .then(({ preferences }) => {
        if (!cancelled) setCurrent(preferences.currency);
      })
      .catch((e) => errorCenter.report(e, { action: "currency.load" }));
    return subscribeCurrency(() => setCurrent(getCurrency()));
  }, []);

  async function applySwitch(to: CurrencyCode) {
    setBusy(true);
    try {
      const result = await getServices().currency.switchCurrency(to);
      if (result.switched) {
        setCurrent(to);
        errorCenter.notify({ key: "toast.currencySwitched", vars: { to } });
      }
    } catch (e) {
      errorCenter.report(e, { action: "currency.switch" });
    } finally {
      setBusy(false);
    }
  }

  async function choose(to: CurrencyCode) {
    if (to === current || busy) return;
    try {
      // With no amounts to convert there is nothing to warn about: switch at
      // once, with no dialog and no rate fetch.
      if (!(await getServices().currency.hasConvertibleData())) {
        await applySwitch(to);
        return;
      }
      const left = await getServices().currency.remainingSwitches();
      setRemaining(left);
      setPending(to);
      setDialog(left <= 0 ? "limit" : "confirm");
    } catch (e) {
      errorCenter.report(e, { action: "currency.switch" });
    }
  }

  async function handleConfirm() {
    if (!pending) return;
    const to = pending;
    setDialog(null);
    setPending(null);
    await applySwitch(to);
  }

  function closeDialog() {
    setDialog(null);
    setPending(null);
  }

  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <h2 className="text-base font-semibold text-plum-900">{t("settings.currency")}</h2>
      <p className="mt-1 text-sm text-muted">{t("settings.currencyHint")}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {CURRENCIES.map((code) => {
          const isCurrent = code === current;
          return (
            <button
              key={code}
              type="button"
              disabled={busy}
              aria-current={isCurrent ? "true" : undefined}
              onClick={() => void choose(code)}
              className={
                isCurrent
                  ? "inline-flex h-10 max-sm:h-11 items-center justify-center rounded-control bg-plum-100 px-4 text-sm font-medium text-plum-900 transition-colors duration-200 disabled:cursor-not-allowed"
                  : "inline-flex h-10 max-sm:h-11 items-center justify-center rounded-control border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors duration-200 hover:bg-plum-50 disabled:cursor-not-allowed"
              }
            >
              {code}
            </button>
          );
        })}
      </div>

      <ConfirmDialog
        open={dialog === "confirm" && pending !== null}
        title={t("currency.confirmTitle")}
        body={pending ? `${t("currency.confirmBody", { from: current, to: pending, remaining })} ${t("currency.rateNote")}` : ""}
        confirmLabel={t("currency.confirm")}
        cancelLabel={t("action.cancel")}
        onConfirm={() => void handleConfirm()}
        onCancel={closeDialog}
      />

      <Modal open={dialog === "limit"} onOpenChange={(o) => !o && closeDialog()} title={t("currency.confirmTitle")}>
        <p className="text-sm text-muted">{t("currency.limitReached")}</p>
        <div className="mt-6 flex justify-end">
          <Button variant="ghost" onClick={closeDialog}>
            {t("action.close")}
          </Button>
        </div>
      </Modal>
    </section>
  );
}
