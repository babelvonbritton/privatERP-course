"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n, type MessageKey } from "@/i18n";
import { getServices, today } from "@/lib/domain/services";
import type { PayrollRun, Trainer } from "@/lib/domain/types";
import { createId } from "@/lib/storage/utils";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { formatMoney } from "@/lib/money";
import { formatDate, monthRange } from "@/lib/dates";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Field } from "../ui/Field";
import { Select } from "../ui/Select";
import { DatePicker } from "../ui/DatePicker";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/Icon";
import { GuideDialog } from "../GuideDialog";
import type { NavId } from "../nav";

/** Turns a millisecond timestamp into a YYYY-MM-DD date for display. */
function dateOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Formats a pay period as a start to end range. */
function periodLabel(run: Pick<PayrollRun, "periodStart" | "periodEnd">, locale: string): string {
  return `${formatDate(run.periodStart, locale)} – ${formatDate(run.periodEnd, locale)}`;
}

const RUN_STATUS_STYLES: Record<PayrollRun["status"], string> = {
  draft: "bg-plum-100 text-plum-900",
  paid: "bg-plum-600 text-white",
};

/** Small status pill for a pay run. */
function RunStatusPill({ status }: { status: PayrollRun["status"] }) {
  const { t } = useI18n();
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${RUN_STATUS_STYLES[status]}`}>
      {t(`status.${status}` as MessageKey)}
    </span>
  );
}

export function PayrollScreen({ navigate: _navigate }: { navigate: (id: NavId) => void }) {
  const { t, locale } = useI18n();
  const s = getServices();
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  const [trainerId, setTrainerId] = useState("");
  const [periodStart, setPeriodStart] = useState(() => monthRange(today()).start);
  const [periodEnd, setPeriodEnd] = useState(() => monthRange(today()).end);
  const [generateError, setGenerateError] = useState("");

  const [detail, setDetail] = useState<PayrollRun | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PayrollRun | null>(null);

  const trainerById = useMemo(() => new Map(trainers.map((tr) => [tr.id, tr])), [trainers]);

  /** Reloads the pay run list. */
  async function reloadRuns() {
    setRuns(await s.payroll.list());
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ts, rs] = await Promise.all([s.trainers.list(), s.payroll.list()]);
        if (cancelled) return;
        setTrainers(ts);
        setRuns(rs);
      } catch (e) {
        errorCenter.report(e, { action: "payroll.list" });
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sortedRuns = useMemo(
    () =>
      [...runs].sort((a, b) =>
        a.periodStart !== b.periodStart
          ? b.periodStart.localeCompare(a.periodStart)
          : b.createdAt - a.createdAt,
      ),
    [runs],
  );

  async function submitGenerate() {
    if (!trainerId) {
      setGenerateError(t("validation.required", { field: t("field.trainer") }));
      return;
    }
    if (!periodStart || !periodEnd) {
      setGenerateError(t("validation.required", { field: t("payroll.period") }));
      return;
    }
    setGenerateError("");
    try {
      await s.payroll.generate({
        trainerId,
        periodStart,
        periodEnd,
        idempotencyKey: createId(),
      });
      await reloadRuns();
      errorCenter.notify({ key: "toast.saved" });
    } catch (e) {
      errorCenter.report(e, { action: "payroll.generate" });
    }
  }

  async function submitMarkPaid() {
    if (!detail) return;
    try {
      const updated = await s.payroll.setStatus(detail.id, {
        status: "paid",
        idempotencyKey: createId(),
      });
      await reloadRuns();
      setDetail(updated);
      errorCenter.notify({ key: "toast.saved" });
    } catch (e) {
      errorCenter.report(e, { action: "payroll.update" });
    }
  }

  async function submitDelete() {
    if (!confirmDelete) return;
    const period = periodLabel(confirmDelete, locale);
    const trainerName = trainerById.get(confirmDelete.trainerId)?.name;
    const label = trainerName ? `${trainerName} · ${period}` : period;
    try {
      await s.payroll.remove(confirmDelete.id);
      await reloadRuns();
      setConfirmDelete(null);
      setDetail(null);
      errorCenter.notify({ key: "trash.movedToTrash", vars: { label } });
    } catch (e) {
      setConfirmDelete(null);
      errorCenter.report(e, { action: "payroll.delete" });
    }
  }

  return (
    <div data-tour="payroll" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <h1 className="text-2xl font-semibold text-plum-900">{t("payroll.title")}</h1>
          <button
            type="button"
            onClick={() => setGuideOpen(true)}
            aria-label={t("guide.open")}
            className="grid size-8 max-sm:size-11 place-items-center rounded-full text-muted transition-colors duration-200 hover:bg-plum-50 hover:text-ink"
          >
            <Icon name="help" size={16} />
          </button>
        </div>
      </div>

      <div className="rounded-card border border-line bg-surface p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex-1">
            <Field label={t("field.trainer")} htmlFor="payroll-trainer">
              <Select
                value={trainerId}
                onChange={setTrainerId}
                options={[
                  { value: "", label: t("payroll.pickTrainer") },
                  ...trainers.map((tr) => ({ value: tr.id, label: tr.name })),
                ]}
                ariaLabel={t("field.trainer")}
                className="w-full"
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label={t("field.periodStart")} htmlFor="payroll-period-start" hint={t("hint.payrollPeriod")}>
              <DatePicker id="payroll-period-start" value={periodStart} onChange={(v) => v && setPeriodStart(v)} />
            </Field>
          </div>
          <div className="flex-1">
            <Field label={t("field.periodEnd")} htmlFor="payroll-period-end">
              <DatePicker id="payroll-period-end" value={periodEnd} onChange={(v) => v && setPeriodEnd(v)} />
            </Field>
          </div>
          <Button className="max-sm:min-h-11" icon="plus" onClick={() => void submitGenerate()}>{t("payroll.generate")}</Button>
        </div>
        {generateError && <p role="alert" className="mt-3 text-sm text-danger">{generateError}</p>}
      </div>

      {loaded && sortedRuns.length === 0 ? (
        <div className="rounded-card border border-line bg-surface px-6 py-10 text-center">
          <p className="text-sm font-medium text-ink">{t("payroll.empty")}</p>
          <p className="mt-1 text-sm text-muted">{t("payroll.emptyHint")}</p>
        </div>
      ) : (
        <div role="region" tabIndex={0} aria-label={t("payroll.title")} className="relative overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th scope="col" className="px-4 py-3 font-medium">{t("field.trainer")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("payroll.period")}</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">{t("payroll.sessionCount")}</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">{t("payroll.rate")}</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">{t("payroll.total")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.status")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("payroll.paidAt")}</th>
              </tr>
            </thead>
            <tbody>
              {sortedRuns.map((run) => (
                <tr
                  key={run.id}
                  onClick={() => setDetail(run)}
                  className="cursor-pointer border-b border-line last:border-b-0 transition-colors duration-200 hover:bg-plum-50"
                >
                  <td className="px-4 py-3 font-medium text-ink">{trainerById.get(run.trainerId)?.name ?? ""}</td>
                  <td className="px-4 py-3 text-muted whitespace-nowrap">{periodLabel(run, locale)}</td>
                  <td className="px-4 py-3 text-right text-ink whitespace-nowrap">{run.sessionCount}</td>
                  <td className="px-4 py-3 text-right text-ink whitespace-nowrap">{formatMoney(run.ratePerSession, locale)}</td>
                  <td className="px-4 py-3 text-right font-medium text-ink whitespace-nowrap">{formatMoney(run.total, locale)}</td>
                  <td className="px-4 py-3"><RunStatusPill status={run.status} /></td>
                  <td className="px-4 py-3 text-muted whitespace-nowrap">
                    {run.paidAt ? formatDate(dateOf(run.paidAt), locale) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <GuideDialog open={guideOpen} section="payroll" onClose={() => setGuideOpen(false)} />

      <Modal
        open={detail !== null}
        onOpenChange={(open) => { if (!open) setDetail(null); }}
        title={t("payroll.review")}
        width="md:max-w-lg"
      >
        {detail && (
          <div className="flex flex-col gap-5">
            <dl className="grid grid-cols-2 gap-3 text-sm max-sm:grid-cols-1">
              <div>
                <dt className="text-muted">{t("field.trainer")}</dt>
                <dd className="font-medium text-ink">{trainerById.get(detail.trainerId)?.name ?? ""}</dd>
              </div>
              <div>
                <dt className="text-muted">{t("payroll.period")}</dt>
                <dd className="font-medium text-ink">{periodLabel(detail, locale)}</dd>
              </div>
              <div>
                <dt className="text-muted">{t("payroll.sessionCount")}</dt>
                <dd className="font-medium text-ink">{detail.sessionCount}</dd>
              </div>
              <div>
                <dt className="text-muted">{t("payroll.rate")}</dt>
                <dd className="font-medium text-ink">{formatMoney(detail.ratePerSession, locale)}</dd>
              </div>
              <div>
                <dt className="text-muted">{t("payroll.total")}</dt>
                <dd className="font-medium text-ink">{formatMoney(detail.total, locale)}</dd>
              </div>
              <div>
                <dt className="text-muted">{t("field.status")}</dt>
                <dd className="mt-0.5"><RunStatusPill status={detail.status} /></dd>
              </div>
              {detail.paidAt && (
                <div>
                  <dt className="text-muted">{t("payroll.paidAt")}</dt>
                  <dd className="font-medium text-ink">{formatDate(dateOf(detail.paidAt), locale)}</dd>
                </div>
              )}
            </dl>

            <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
              <Button className="max-sm:min-h-11" variant="ghost" onClick={() => setDetail(null)}>{t("action.close")}</Button>
              {detail.status === "draft" && (
                <>
                  <Button className="max-sm:min-h-11" variant="dangerSoft" icon="trash" onClick={() => setConfirmDelete(detail)}>{t("action.delete")}</Button>
                  <Button className="max-sm:min-h-11" icon="check" onClick={() => void submitMarkPaid()}>{t("payroll.markPaid")}</Button>
                </>
              )}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("action.delete")}
        body={confirmDelete ? periodLabel(confirmDelete, locale) : ""}
        confirmLabel={t("action.delete")}
        cancelLabel={t("action.cancel")}
        danger
        onConfirm={() => void submitDelete()}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
