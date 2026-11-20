"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/types";
import { getServices, effectiveInvoiceStatus, today } from "@/lib/domain/services";
import type { Course, Enrollment, Invoice, Member, MemberStatus } from "@/lib/domain/types";
import { createId } from "@/lib/storage/utils";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { formatMoney } from "@/lib/money";
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

/** Members screen: searchable table, add and edit form, detail view, delete with confirmation. */
export function MembersScreen({ navigate: _navigate }: { navigate: (id: NavId) => void }) {
  const { t, locale } = useI18n();
  const services = getServices();

  const [items, setItems] = useState<Member[]>([]);
  const [query, setQuery] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<MemberStatus>("active");
  const [nameError, setNameError] = useState("");
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState<Member | null>(null);
  const [detailEnrollments, setDetailEnrollments] = useState<Enrollment[]>([]);
  const [detailInvoices, setDetailInvoices] = useState<Invoice[]>([]);
  const [courseTitles, setCourseTitles] = useState<Map<string, string>>(new Map());

  const [deleteTarget, setDeleteTarget] = useState<Member | null>(null);

  async function load(q: string): Promise<void> {
    try {
      const rows = q.trim() === "" ? await services.members.list() : await services.members.search(q.trim());
      setItems(rows);
    } catch (e) {
      errorCenter.report(e, { action: "member.list" });
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
    setNotes("");
    setStatus("active");
    setNameError("");
    setFormOpen(true);
  }

  function openEdit(member: Member): void {
    setEditing(member);
    setName(member.name);
    setEmail(member.email);
    setPhone(member.phone);
    setNotes(member.notes);
    setStatus(member.status);
    setNameError("");
    setFormOpen(true);
  }

  async function openDetail(member: Member): Promise<void> {
    try {
      const [enrollments, invoices, courses] = await Promise.all([
        services.courses.listEnrollmentsByMember(member.id),
        services.invoices.listByMember(member.id),
        services.courses.list(),
      ]);
      setCourseTitles(new Map(courses.map((c: Course) => [c.id, c.title])));
      setDetailEnrollments(enrollments);
      setDetailInvoices(invoices);
      setDetail(member);
    } catch (e) {
      errorCenter.report(e, { action: "member.detail" });
    }
  }

  async function save(): Promise<void> {
    if (name.trim() === "") {
      setNameError(t("validation.required", { field: t("field.name") }));
      return;
    }
    setNameError("");
    setSaving(true);
    try {
      if (editing) {
        await services.members.update(editing.id, {
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          notes,
          status,
          idempotencyKey: createId(),
        });
      } else {
        await services.members.create({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          notes,
          status,
          idempotencyKey: createId(),
        });
      }
      setFormOpen(false);
      reload();
      errorCenter.notify({ key: "toast.saved" });
    } catch (e) {
      errorCenter.report(e, { action: editing ? "member.update" : "member.create" });
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    try {
      await services.members.remove(deleteTarget.id);
      setDeleteTarget(null);
      reload();
      errorCenter.notify({ key: "toast.deleted" });
    } catch (e) {
      errorCenter.report(e, { action: "member.delete" });
    }
  }

  function statusLabel(value: MemberStatus): string {
    return t(`status.${value}` as MessageKey);
  }

  return (
    <div data-tour="members" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <h1 className="text-2xl font-semibold text-plum-900">{t("member.title")}</h1>
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
          {t("member.add")}
        </Button>
      </div>

      <SearchField value={query} onChange={setQuery} placeholder={t("member.search")} clearLabel={t("search.clear")} />
      <p className="text-sm text-muted">{t("member.count", { count: items.length })}</p>

      {items.length === 0 ? (
        <div className="rounded-card border border-line bg-surface px-6 py-10 text-center">
          <p className="text-sm font-medium text-ink">{t("member.empty")}</p>
          <p className="mt-1 text-sm text-muted">{t("member.emptyHint")}</p>
        </div>
      ) : (
        <div role="region" tabIndex={0} aria-label={t("member.title")} className="relative overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full min-w-[560px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line text-muted">
                <th scope="col" className="px-4 py-3 font-medium">{t("field.name")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.email")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.phone")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.status")}</th>
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">{t("action.edit")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((member) => (
                <tr
                  key={member.id}
                  onClick={() => void openDetail(member)}
                  className="cursor-pointer border-b border-line transition-colors duration-200 last:border-b-0 hover:bg-plum-50"
                >
                  <td className="px-4 py-3 font-medium text-ink">{member.name}</td>
                  <td className="max-w-0 truncate px-4 py-3 text-muted">{member.email}</td>
                  <td className="px-4 py-3 text-muted">{member.phone}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${member.status === "active" ? "bg-plum-100 text-plum-900" : "bg-plum-50 text-muted"}`}>
                      {statusLabel(member.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        aria-label={t("member.edit")}
                        onClick={(e) => {
                          e.stopPropagation();
                          openEdit(member);
                        }}
                        className="grid size-8 max-sm:size-11 place-items-center rounded-full text-muted transition-colors duration-200 hover:bg-plum-100 hover:text-ink"
                      >
                        <Icon name="pencil" size={16} />
                      </button>
                      <button
                        type="button"
                        aria-label={t("member.delete")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(member);
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
        title={editing ? t("member.edit") : t("member.add")}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label={t("field.name")} htmlFor="member-name" hint={t("hint.memberName")}>
            <input
              id="member-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`${inputClass} h-10`}
            />
            {nameError && <p className="text-sm text-danger">{nameError}</p>}
          </Field>
          <Field label={t("field.email")} htmlFor="member-email" hint={t("hint.memberEmail")}>
            <input
              id="member-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`${inputClass} h-10`}
            />
          </Field>
          <Field label={t("field.phone")} htmlFor="member-phone" hint={t("hint.memberPhone")}>
            <input
              id="member-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={`${inputClass} h-10`}
            />
          </Field>
          <Field label={t("field.notes")} htmlFor="member-notes" hint={t("hint.memberNotes")}>
            <textarea
              id="member-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={`${inputClass} py-2`}
            />
          </Field>
          <Field label={t("field.status")} htmlFor="member-status">
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
            <h3 className="text-sm font-semibold text-plum-900">{t("member.detail.enrollments")}</h3>
            {detailEnrollments.length === 0 ? (
              <p className="mt-2 text-sm text-muted">{t("enrollment.empty")}</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {detailEnrollments.map((enrollment) => (
                  <li key={enrollment.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                    <span className="font-medium text-ink">{courseTitles.get(enrollment.courseId) ?? ""}</span>
                    <span className="text-muted">
                      {t(`status.${enrollment.status}` as MessageKey)} · {formatDate(enrollment.startDate, locale)}
                      {enrollment.endDate ? ` - ${formatDate(enrollment.endDate, locale)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3 className="text-sm font-semibold text-plum-900">{t("member.detail.invoices")}</h3>
            {detailInvoices.length === 0 ? (
              <p className="mt-2 text-sm text-muted">{t("invoice.empty")}</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {detailInvoices.map((invoice) => (
                  <li key={invoice.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                    <span className="font-medium text-ink">{invoice.number}</span>
                    <span className="text-muted">
                      {formatMoney(invoice.total, locale)} · {t("invoice.paid")}: {formatMoney(invoice.paidAmount, locale)} ·{" "}
                      {t(`status.${effectiveInvoiceStatus(invoice, today())}` as MessageKey)}
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
        title={t("member.delete")}
        body={deleteTarget ? t("member.deleteBody", { name: deleteTarget.name }) : ""}
        confirmLabel={t("action.delete")}
        cancelLabel={t("action.cancel")}
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

      <GuideDialog open={guideOpen} section="members" onClose={() => setGuideOpen(false)} />
    </div>
  );
}
