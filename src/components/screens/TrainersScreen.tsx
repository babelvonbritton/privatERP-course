"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/types";
import { getServices } from "@/lib/domain/services";
import type { Course, PayrollRun, Trainer, TrainerStatus } from "@/lib/domain/types";
import { createId } from "@/lib/storage/utils";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { formatMoney } from "@/lib/money";
import { fractionDigits, getCurrency, subscribeCurrency } from "@/lib/currency";
import type { CurrencyCode } from "@/lib/domain/types";
import { formatDate } from "@/lib/dates";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Field, inputClass } from "../ui/Field";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";
import { SearchField } from "../ui/SearchField";
import { Select } from "../ui/Select";
import { GuideDialog } from "../GuideDialog";
import type { NavId } from "../nav";

/** Splits a subjects field into a clean list: one subject per line or separated by commas. */
function parseSubjects(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Trainers screen: searchable table, add and edit form, detail view, delete with confirmation. */
export function TrainersScreen({ navigate: _navigate }: { navigate: (id: NavId) => void }) {
  const { t, locale } = useI18n();
  const services = getServices();

  const [items, setItems] = useState<Trainer[]>([]);
  const [query, setQuery] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const [currency, setCurrency] = useState<CurrencyCode>(() => getCurrency());

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Trainer | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [subjects, setSubjects] = useState("");
  const [rate, setRate] = useState("0");
  const [status, setStatus] = useState<TrainerStatus>("active");
  const [nameError, setNameError] = useState("");
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState<Trainer | null>(null);
  const [detailCourses, setDetailCourses] = useState<Course[]>([]);
  const [detailPayRuns, setDetailPayRuns] = useState<PayrollRun[]>([]);

  const [deleteTarget, setDeleteTarget] = useState<Trainer | null>(null);

  useEffect(() => subscribeCurrency(() => setCurrency(getCurrency())), []);

  async function load(q: string): Promise<void> {
    try {
      const rows = q.trim() === "" ? await services.trainers.list() : await services.trainers.search(q.trim());
      setItems(rows);
    } catch (e) {
      errorCenter.report(e, { action: "trainer.list" });
    }
  }

  function reload(): void {
    void load(query);
  }

  useEffect(() => {
    const handle = setTimeout(() => {
      void load(query);
    }, 180);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function openAdd(): void {
    setEditing(null);
    setName("");
    setEmail("");
    setPhone("");
    setSubjects("");
    setRate("0");
    setStatus("active");
    setNameError("");
    setFormOpen(true);
  }

  function openEdit(trainer: Trainer): void {
    setEditing(trainer);
    setName(trainer.name);
    setEmail(trainer.email);
    setPhone(trainer.phone);
    setSubjects(trainer.subjects.join("\n"));
    setRate(String(trainer.ratePerSession));
    setStatus(trainer.status);
    setNameError("");
    setFormOpen(true);
  }

  async function openDetail(trainer: Trainer): Promise<void> {
    try {
      const [courses, runs] = await Promise.all([
        services.courses.listByTrainer(trainer.id),
        services.payroll.listByTrainer(trainer.id),
      ]);
      setDetailCourses(courses);
      setDetailPayRuns(runs);
      setDetail(trainer);
    } catch (e) {
      errorCenter.report(e, { action: "trainer.detail" });
    }
  }

  async function save(): Promise<void> {
    if (name.trim() === "") {
      setNameError(t("validation.required", { field: t("field.name") }));
      return;
    }
    setNameError("");
    const ratePerSession = Number(rate);
    setSaving(true);
    try {
      if (editing) {
        await services.trainers.update(editing.id, {
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          subjects: parseSubjects(subjects),
          ratePerSession,
          status,
          idempotencyKey: createId(),
        });
      } else {
        await services.trainers.create({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          subjects: parseSubjects(subjects),
          ratePerSession,
          status,
          idempotencyKey: createId(),
        });
      }
      setFormOpen(false);
      reload();
      errorCenter.notify({ key: "toast.saved" });
    } catch (e) {
      errorCenter.report(e, { action: editing ? "trainer.update" : "trainer.create" });
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    try {
      await services.trainers.remove(deleteTarget.id);
      setDeleteTarget(null);
      reload();
      errorCenter.notify({ key: "toast.deleted" });
    } catch (e) {
      errorCenter.report(e, { action: "trainer.delete" });
    }
  }

  function statusLabel(value: TrainerStatus): string {
    return t(`status.${value}` as MessageKey);
  }

  return (
    <div data-tour="trainers" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <h1 className="text-2xl font-semibold text-plum-900">{t("trainer.title")}</h1>
          <button
            type="button"
            onClick={() => setGuideOpen(true)}
            aria-label={t("guide.open")}
            className="grid size-8 max-sm:size-11 place-items-center rounded-full text-muted transition-colors duration-200 hover:bg-plum-50 hover:text-ink"
          >
            <Icon name="help" size={16} />
          </button>
        </div>
        <Button className="max-sm:min-h-11" icon="plus" onClick={openAdd}>
          {t("trainer.add")}
        </Button>
      </div>

      <SearchField value={query} onChange={setQuery} placeholder={t("trainer.search")} clearLabel={t("search.clear")} />
      <p className="text-sm text-muted">{t("trainer.count", { count: items.length })}</p>

      {items.length === 0 ? (
        <div className="rounded-card border border-line bg-surface px-6 py-10 text-center">
          <p className="text-sm font-medium text-ink">{t("trainer.empty")}</p>
          <p className="mt-1 text-sm text-muted">{t("trainer.emptyHint")}</p>
        </div>
      ) : (
        <div role="region" tabIndex={0} aria-label={t("trainer.title")} className="relative overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line text-muted">
                <th scope="col" className="px-4 py-3 font-medium">{t("field.name")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.email")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.phone")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.subjects")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.ratePerSession")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.status")}</th>
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">{t("action.edit")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((trainer) => (
                <tr
                  key={trainer.id}
                  onClick={() => void openDetail(trainer)}
                  className="cursor-pointer border-b border-line transition-colors duration-200 last:border-b-0 hover:bg-plum-50"
                >
                  <td className="px-4 py-3 font-medium text-ink">{trainer.name}</td>
                  <td className="max-w-0 truncate px-4 py-3 text-muted">{trainer.email}</td>
                  <td className="px-4 py-3 text-muted">{trainer.phone}</td>
                  <td className="max-w-[12rem] truncate px-4 py-3 text-muted">{trainer.subjects.join(", ")}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted">{formatMoney(trainer.ratePerSession, locale)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${trainer.status === "active" ? "bg-plum-100 text-plum-900" : "bg-plum-50 text-muted"}`}>
                      {statusLabel(trainer.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        aria-label={t("trainer.edit")}
                        onClick={(e) => {
                          e.stopPropagation();
                          openEdit(trainer);
                        }}
                        className="grid size-8 max-sm:size-11 place-items-center rounded-full text-muted transition-colors duration-200 hover:bg-plum-100 hover:text-ink"
                      >
                        <Icon name="pencil" size={16} />
                      </button>
                      <button
                        type="button"
                        aria-label={t("trainer.delete")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(trainer);
                        }}
                        className="grid size-8 max-sm:size-11 place-items-center rounded-full text-muted transition-colors duration-200 hover:bg-danger/10 hover:text-danger"
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={formOpen}
        onOpenChange={setFormOpen}
        title={editing ? t("trainer.edit") : t("trainer.add")}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label={t("field.name")} htmlFor="trainer-name" hint={t("hint.memberName")}>
            <input
              id="trainer-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`${inputClass} h-10`}
            />
            {nameError && <p className="text-sm text-danger">{nameError}</p>}
          </Field>
          <Field label={t("field.email")} htmlFor="trainer-email" hint={t("hint.memberEmail")}>
            <input
              id="trainer-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`${inputClass} h-10`}
            />
          </Field>
          <Field label={t("field.phone")} htmlFor="trainer-phone" hint={t("hint.memberPhone")}>
            <input
              id="trainer-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={`${inputClass} h-10`}
            />
          </Field>
          <Field label={t("field.subjects")} htmlFor="trainer-subjects" hint={t("hint.trainerSubjects")}>
            <textarea
              id="trainer-subjects"
              rows={3}
              value={subjects}
              onChange={(e) => setSubjects(e.target.value)}
              className={`${inputClass} py-2`}
            />
          </Field>
          <Field label={t("field.ratePerSession")} htmlFor="trainer-rate" hint={t("hint.trainerRate")}>
            <input
              id="trainer-rate"
              type="number"
              min={0}
              step={fractionDigits(currency) === 0 ? 1 : 0.01}
              inputMode={fractionDigits(currency) === 0 ? "numeric" : "decimal"}
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              className={`${inputClass} h-10`}
            />
          </Field>
          <Field label={t("field.status")} htmlFor="trainer-status">
            <Select
              value={status}
              onChange={setStatus}
              ariaLabel={t("field.status")}
              options={[
                { value: "active", label: t("status.active") },
                { value: "inactive", label: t("status.inactive") },
              ]}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button className="max-sm:min-h-11" variant="ghost" onClick={() => setFormOpen(false)}>
              {t("action.cancel")}
            </Button>
            <Button className="max-sm:min-h-11" type="submit" disabled={saving}>
              {t("action.save")}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={detail !== null} onOpenChange={(open) => !open && setDetail(null)} title={detail?.name ?? ""}>
        <div className="flex flex-col gap-6">
          <section>
            <h3 className="text-sm font-semibold text-plum-900">{t("trainer.detail.courses")}</h3>
            {detailCourses.length === 0 ? (
              <p className="mt-2 text-sm text-muted">{t("course.empty")}</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {detailCourses.map((course) => (
                  <li key={course.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                    <span className="font-medium text-ink">{course.title}</span>
                    <span className="text-muted">
                      {course.level} · {formatMoney(course.price, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3 className="text-sm font-semibold text-plum-900">{t("trainer.detail.payRuns")}</h3>
            {detailPayRuns.length === 0 ? (
              <p className="mt-2 text-sm text-muted">{t("payroll.empty")}</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {detailPayRuns.map((run) => (
                  <li key={run.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                    <span className="font-medium text-ink">
                      {formatDate(run.periodStart, locale)} - {formatDate(run.periodEnd, locale)}
                    </span>
                    <span className="text-muted">
                      {t("payroll.sessionCount")}: {run.sessionCount} · {formatMoney(run.total, locale)} ·{" "}
                      {t(`status.${run.status}` as MessageKey)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <div className="flex justify-end">
            <Button className="max-sm:min-h-11" variant="ghost" onClick={() => setDetail(null)}>
              {t("action.close")}
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("trainer.delete")}
        body={deleteTarget ? t("trainer.deleteBody", { name: deleteTarget.name }) : ""}
        confirmLabel={t("action.delete")}
        cancelLabel={t("action.cancel")}
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

      <GuideDialog open={guideOpen} section="trainers" onClose={() => setGuideOpen(false)} />
    </div>
  );
}
