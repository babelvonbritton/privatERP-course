"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n, type MessageKey } from "@/i18n";
import { getServices, today, effectiveInvoiceStatus } from "@/lib/domain/services";
import type { Course, CurrencyCode, Enrollment, Invoice, InvoiceDisplayStatus, Member, Payment, PaymentMethod } from "@/lib/domain/types";
import { getCurrency, subscribeCurrency } from "@/lib/currency";
import { createId } from "@/lib/storage/utils";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { formatMoney } from "@/lib/money";
import { formatDate, parseDate } from "@/lib/dates";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Field, inputClass } from "../ui/Field";
import { Select } from "../ui/Select";
import { SearchField } from "../ui/SearchField";
import { DatePicker } from "../ui/DatePicker";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/Icon";
import { GuideDialog } from "../GuideDialog";
import { InvoiceDocument } from "../invoices/InvoiceDocument";
import { paymentDetailsOf, paymentMethodOf, paymentMethodValue } from "@/lib/invoicePayment";
import { downloadInvoicePdf, downloadInvoicePng } from "@/lib/invoiceExport";
import type { Attachment } from "@/lib/domain/attachments";
import type { PreparedAttachment } from "@/lib/attachments/compress";
import { AttachmentUploader } from "../attachments/AttachmentUploader";
import { AttachmentThumbnails, type ThumbSource } from "../attachments/AttachmentThumbnails";
import { AttachmentLightbox } from "../attachments/AttachmentLightbox";
import type { NavId } from "../nav";

type StatusFilter = "all" | InvoiceDisplayStatus;

interface LineDraft {
  description: string;
  amount: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Adds days to a YYYY-MM-DD date and returns a YYYY-MM-DD date. */
function addDays(iso: string, days: number): string {
  const d = parseDate(iso);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Turns a millisecond timestamp into a YYYY-MM-DD date for display. */
function dateOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

const STATUS_STYLES: Record<InvoiceDisplayStatus, string> = {
  draft: "bg-plum-100 text-plum-900",
  sent: "bg-plum-600 text-white",
  partial: "bg-brass/15 text-brass-700",
  paid: "bg-plum-900 text-white",
  overdue: "bg-danger text-white",
};

/** Small status pill using the effective (derived) invoice status. */
function StatusPill({ status }: { status: InvoiceDisplayStatus }) {
  const { t } = useI18n();
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_STYLES[status]}`}>
      {t(`status.${status}` as MessageKey)}
    </span>
  );
}

export function InvoicesScreen({ navigate: _navigate }: { navigate: (id: NavId) => void }) {
  const { t, locale } = useI18n();
  const s = getServices();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [guideOpen, setGuideOpen] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [formMemberId, setFormMemberId] = useState("");
  const [formEnrollments, setFormEnrollments] = useState<Enrollment[]>([]);
  const [formEnrollmentId, setFormEnrollmentId] = useState("");
  const [formDueDate, setFormDueDate] = useState(() => addDays(today(), 14));
  const [formStatus, setFormStatus] = useState<"draft" | "sent">("draft");
  const [formPaymentMethod, setFormPaymentMethod] = useState<PaymentMethod>("cash");
  const [formPaymentDetails, setFormPaymentDetails] = useState("");
  const [formLines, setFormLines] = useState<LineDraft[]>([{ description: "", amount: "" }]);
  // Index of the charge line filled in from the picked course, if any. Only
  // that line follows course changes; lines the user typed are never touched.
  const [autoLine, setAutoLine] = useState<number | null>(null);
  const [formError, setFormError] = useState("");
  const [currency, setCurrencyState] = useState<CurrencyCode>(() => getCurrency());
  const [pendingAttachments, setPendingAttachments] = useState<Array<{ key: string; prepared: PreparedAttachment }>>([]);

  const [detail, setDetail] = useState<Invoice | null>(null);
  const [detailPayments, setDetailPayments] = useState<Payment[]>([]);
  const [attachmentRows, setAttachmentRows] = useState<Attachment[]>([]);
  const [attachmentBlobs, setAttachmentBlobs] = useState<Map<string, Blob>>(new Map());
  const [lightboxAttachment, setLightboxAttachment] = useState<Attachment | null>(null);
  const [confirmDeleteAttachment, setConfirmDeleteAttachment] = useState<Attachment | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const docRef = useRef<HTMLDivElement>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<PaymentMethod>("cash");
  const [payError, setPayError] = useState("");
  const [confirmDeletePayment, setConfirmDeletePayment] = useState<Payment | null>(null);

  const [edit, setEdit] = useState<Invoice | null>(null);
  const [editDueDate, setEditDueDate] = useState("");
  const [editStatus, setEditStatus] = useState<"draft" | "sent">("draft");
  const [editPaymentMethod, setEditPaymentMethod] = useState<PaymentMethod>("cash");
  const [editPaymentDetails, setEditPaymentDetails] = useState("");
  const [editError, setEditError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Invoice | null>(null);

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const courseById = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);
  const now = today();

  /** Reloads the invoice list for the current search text. */
  async function reloadInvoices(q: string) {
    const rows = q.trim() ? await s.invoices.search(q.trim()) : await s.invoices.list();
    setInvoices(rows);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ms, cs] = await Promise.all([s.members.list(), s.courses.list()]);
        if (cancelled) return;
        setMembers(ms);
        setCourses(cs);
        await reloadInvoices("");
      } catch (e) {
        errorCenter.report(e, { action: "invoice.list" });
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query), 180);
    return () => clearTimeout(handle);
  }, [query]);

  // The currency label next to the charge amount follows the current setting.
  useEffect(() => subscribeCurrency(() => setCurrencyState(getCurrency())), []);

  useEffect(() => {
    if (!loaded) return;
    reloadInvoices(debouncedQuery).catch((e) => errorCenter.report(e, { action: "invoice.list" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  /** Reloads one invoice and its payments for the open detail view. */
  async function refreshDetail(id: string) {
    const [inv, payments] = await Promise.all([s.invoices.get(id), s.invoices.listPayments(id)]);
    if (inv) setDetail(inv);
    setDetailPayments(payments);
    await loadAttachmentRows(id);
  }

  /** Loads the attachment rows and file bytes of one invoice for the detail or edit view. */
  async function loadAttachmentRows(invoiceId: string) {
    try {
      const rows = await s.attachments.list("invoice", invoiceId);
      const blobs = new Map<string, Blob>();
      await Promise.all(
        rows.map(async (row) => {
          const blob = await s.attachments.getBlob(row.id);
          if (blob) blobs.set(row.id, blob);
        }),
      );
      setAttachmentRows(rows);
      setAttachmentBlobs(blobs);
    } catch (e) {
      errorCenter.report(e, { action: "attachment.list" });
    }
  }

  /** Thumbnails for the stored attachments of the open invoice. Memoized so typing elsewhere in the open modal does not rebuild the object URLs and flicker the images. */
  const storedThumbs = useMemo(
    (): ThumbSource[] =>
      attachmentRows.map((row) => ({
        key: row.id,
        fileName: row.fileName,
        sizeBytes: row.sizeBytes,
        blob: attachmentBlobs.get(row.id) ?? null,
      })),
    [attachmentRows, attachmentBlobs],
  );

  const printableAttachments = useMemo(
    () =>
      attachmentRows.map((row) => ({
        id: row.id,
        fileName: row.fileName,
        blob: attachmentBlobs.get(row.id) ?? null,
      })),
    [attachmentRows, attachmentBlobs],
  );

  /** Thumbnails for files picked while creating, memoized for the same reason. */
  const pendingThumbs = useMemo(
    (): ThumbSource[] =>
      pendingAttachments.map((p) => ({ key: p.key, fileName: p.prepared.fileName, sizeBytes: p.prepared.sizeBytes, blob: p.prepared.blob })),
    [pendingAttachments],
  );

  /** Removes one attachment after confirmation, from the detail view, the edit view, or the lightbox. */
  async function removeAttachment(att: Attachment) {
    const invoiceId = detail?.id ?? edit?.id;
    try {
      await s.attachments.remove(att.id);
      setConfirmDeleteAttachment(null);
      setLightboxAttachment(null);
      if (invoiceId) await loadAttachmentRows(invoiceId);
      errorCenter.notify({ key: "toast.deleted" });
    } catch (e) {
      setConfirmDeleteAttachment(null);
      errorCenter.report(e, { action: "attachment.delete" });
    }
  }

  function openDetail(inv: Invoice) {
    setDetail(inv);
    setPayAmount("");
    setPayMethod("cash");
    setPayError("");
    refreshDetail(inv.id).catch((e) => errorCenter.report(e, { action: "invoice.get" }));
  }

  /** Exports the open invoice; the download itself is the success feedback. */
  async function runExport(kind: "pdf" | "png") {
    if (!detail || !docRef.current || exporting) return;
    setExporting(true);
    try {
      const node = docRef.current.firstElementChild as HTMLElement | null;
      if (!node) throw new Error("invoice document is missing");
      if (kind === "pdf") await downloadInvoicePdf(node, detail.number);
      else await downloadInvoicePng(node, detail.number);
      setPrintOpen(false);
    } catch (e) {
      errorCenter.report(e, { action: "invoice.export" });
    } finally {
      setExporting(false);
    }
  }

  function openCreate() {
    setFormMemberId("");
    setFormEnrollments([]);
    setFormEnrollmentId("");
    setFormDueDate(addDays(today(), 14));
    setFormStatus("draft");
    setFormPaymentMethod("cash");
    setFormPaymentDetails("");
    setFormLines([{ description: "", amount: "" }]);
    setAutoLine(null);
    setFormError("");
    setPendingAttachments([]);
    setCreateOpen(true);
  }

  /** Loads the enrollments of the member picked in the create form. */
  async function pickMember(memberId: string) {
    setFormMemberId(memberId);
    setFormEnrollmentId("");
    // The picked course belongs to the previous member, so its filled line goes too.
    dropAutoLine();
    if (!memberId) {
      setFormEnrollments([]);
      return;
    }
    try {
      setFormEnrollments(await s.courses.listEnrollmentsByMember(memberId));
    } catch (e) {
      errorCenter.report(e, { action: "invoice.create" });
    }
  }

  /** Removes the line filled in from the course, leaving one blank line if the list would become empty. */
  function dropAutoLine() {
    if (autoLine === null) return;
    const index = autoLine;
    setAutoLine(null);
    setFormLines((lines) => {
      const next = lines.filter((_, j) => j !== index);
      return next.length ? next : [{ description: "", amount: "" }];
    });
  }

  /** Fills the first charge line from the picked course and keeps it in step with later course changes. */
  function pickEnrollment(enrollmentId: string) {
    setFormEnrollmentId(enrollmentId);
    if (!enrollmentId) {
      dropAutoLine();
      return;
    }
    const enrollment = formEnrollments.find((e) => e.id === enrollmentId);
    const course = enrollment ? courseById.get(enrollment.courseId) : undefined;
    if (!course) return;
    const filled = { description: course.title, amount: String(course.price) };
    if (autoLine !== null) {
      setFormLines((lines) => lines.map((line, i) => (i === autoLine ? filled : line)));
      return;
    }
    // Only a still-blank first line is filled; lines the user already typed stay as they are.
    const first = formLines[0];
    if (first && !first.description.trim() && !first.amount) {
      setFormLines((lines) => lines.map((line, i) => (i === 0 ? filled : line)));
      setAutoLine(0);
    }
  }

  const formTotal = useMemo(
    () => formLines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0),
    [formLines],
  );

  function setLine(index: number, patch: Partial<LineDraft>) {
    // Editing a line by hand takes it out of the auto-filled set, so a later
    // course change never overwrites what the user typed.
    if (index === autoLine) setAutoLine(null);
    setFormLines((lines) => lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  /** Removes one charge line, keeping the auto-filled tracker in step. */
  function removeLine(index: number) {
    if (index === autoLine) setAutoLine(null);
    else if (autoLine !== null && index < autoLine) setAutoLine(autoLine - 1);
    setFormLines((lines) => {
      const next = lines.filter((_, j) => j !== index);
      return next.length ? next : [{ description: "", amount: "" }];
    });
  }

  async function submitCreate() {
    if (!formMemberId) {
      setFormError(t("validation.required", { field: t("field.member") }));
      return;
    }
    if (formLines.length === 0) {
      setFormError(t("validation.required", { field: t("invoice.charges") }));
      return;
    }
    const items: Array<{ description: string; amount: number }> = [];
    for (const line of formLines) {
      const amount = Number(line.amount);
      if (!line.description.trim()) {
        setFormError(t("validation.required", { field: t("field.description") }));
        return;
      }
      if (!Number.isFinite(amount) || amount < 0) {
        setFormError(t("validation.positive", { field: t("field.amount") }));
        return;
      }
      items.push({ description: line.description.trim(), amount });
    }
    if (!formDueDate) {
      setFormError(t("validation.required", { field: t("field.dueDate") }));
      return;
    }
    try {
      const created = await s.invoices.create({
        memberId: formMemberId,
        enrollmentId: formEnrollmentId || null,
        lineItems: items,
        dueDate: formDueDate,
        status: formStatus,
        paymentMethod: formPaymentMethod,
        paymentDetails: formPaymentMethod === "cash" ? "" : formPaymentDetails.trim(),
        idempotencyKey: createId(),
      });
      // Files picked while creating are stored now that the invoice exists.
      // A failed upload is reported, never silent, and never blocks the invoice.
      for (const pending of pendingAttachments) {
        try {
          await s.attachments.add({ entityType: "invoice", entityId: created.id, prepared: pending.prepared });
        } catch (e) {
          errorCenter.report(e, { action: "attachment.add" });
        }
      }
      setPendingAttachments([]);
      await reloadInvoices(debouncedQuery);
      setCreateOpen(false);
      errorCenter.notify({ key: "toast.saved" });
    } catch (e) {
      errorCenter.report(e, { action: "invoice.create" });
    }
  }

  function openEdit(inv: Invoice) {
    setDetail(null);
    setEdit(inv);
    setEditDueDate(inv.dueDate);
    setEditStatus(inv.status === "sent" || inv.status === "partial" ? "sent" : "draft");
    // A legacy invoice without payment fields opens as cash with no details.
    setEditPaymentMethod(paymentMethodOf(inv));
    setEditPaymentDetails(paymentDetailsOf(inv));
    setEditError("");
    void loadAttachmentRows(inv.id);
  }

  async function submitEdit() {
    if (!edit) return;
    if (!editDueDate) {
      setEditError(t("validation.required", { field: t("field.dueDate") }));
      return;
    }
    try {
      // Only a draft or sent invoice can change status here; a paid or
      // partially paid invoice keeps its stored status and only the due date changes.
      // The payment fields are always sent, so a legacy invoice without them
      // gets them written on this save.
      const patch: { dueDate: string; status?: "draft" | "sent"; paymentMethod: PaymentMethod; paymentDetails: string; idempotencyKey: string } = {
        dueDate: editDueDate,
        paymentMethod: editPaymentMethod,
        paymentDetails: editPaymentMethod === "cash" ? "" : editPaymentDetails.trim(),
        idempotencyKey: createId(),
      };
      if (edit.status === "draft" || edit.status === "sent") patch.status = editStatus;
      const updated = await s.invoices.update(edit.id, patch);
      await reloadInvoices(debouncedQuery);
      setEdit(null);
      errorCenter.notify({ key: "toast.saved" });
      openDetail(updated);
    } catch (e) {
      errorCenter.report(e, { action: "invoice.update" });
    }
  }

  async function submitDelete() {
    if (!confirmDelete) return;
    try {
      await s.invoices.remove(confirmDelete.id);
      await reloadInvoices(debouncedQuery);
      setConfirmDelete(null);
      setDetail(null);
      errorCenter.notify({ key: "toast.deleted" });
    } catch (e) {
      setConfirmDelete(null);
      errorCenter.report(e, { action: "invoice.delete" });
    }
  }

  const detailRemaining = detail ? detail.total - detail.paidAmount : 0;
  const detailEffective = detail ? effectiveInvoiceStatus(detail, now) : null;
  const canPay = detailEffective === "sent" || detailEffective === "partial" || detailEffective === "overdue";

  async function record(amount: number, method: PaymentMethod) {
    if (!detail) return;
    try {
      await s.invoices.recordPayment({
        invoiceId: detail.id,
        amount,
        method,
        idempotencyKey: createId(),
      });
      await reloadInvoices(debouncedQuery);
      await refreshDetail(detail.id);
      setPayAmount("");
      setPayError("");
      errorCenter.notify({ key: "toast.paid" });
    } catch (e) {
      errorCenter.report(e, { action: "invoice.pay" });
    }
  }

  function submitPayment() {
    if (!detail) return;
    const amount = Number(payAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setPayError(t("validation.positive", { field: t("invoice.paymentAmount") }));
      return;
    }
    if (amount > detailRemaining) {
      setPayError(t("hint.paymentAmount"));
      return;
    }
    void record(amount, payMethod);
  }

  async function submitDeletePayment() {
    if (!confirmDeletePayment || !detail) return;
    try {
      await s.invoices.removePayment(confirmDeletePayment.id);
      await reloadInvoices(debouncedQuery);
      await refreshDetail(detail.id);
      setConfirmDeletePayment(null);
      errorCenter.notify({ key: "toast.deleted" });
    } catch (e) {
      setConfirmDeletePayment(null);
      errorCenter.report(e, { action: "payment.delete" });
    }
  }

  const visible = useMemo(() => {
    const rows = filter === "all" ? invoices : invoices.filter((inv) => effectiveInvoiceStatus(inv, now) === filter);
    return [...rows].sort((a, b) => b.createdAt - a.createdAt);
  }, [invoices, filter, now]);

  const statusOptions: Array<{ value: StatusFilter; label: string }> = [
    { value: "all", label: t("invoice.filter.all") },
    { value: "draft", label: t("invoice.filter.draft") },
    { value: "sent", label: t("invoice.filter.sent") },
    { value: "paid", label: t("invoice.filter.paid") },
    { value: "partial", label: t("invoice.filter.partial") },
    { value: "overdue", label: t("invoice.filter.overdue") },
  ];

  return (
    <div data-tour="invoices" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <h1 className="text-2xl font-semibold text-plum-900">{t("invoice.title")}</h1>
          <button
            type="button"
            onClick={() => setGuideOpen(true)}
            aria-label={t("guide.open")}
            className="grid size-8 max-sm:size-11 place-items-center rounded-full text-muted transition-colors duration-200 hover:bg-plum-50 hover:text-ink"
          >
            <Icon name="help" size={16} />
          </button>
        </div>
        <Button className="max-sm:min-h-11" icon="plus" onClick={openCreate}>{t("invoice.add")}</Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t("invoice.search")}
          clearLabel={t("search.clear")}
          className="sm:flex-1"
        />
        <Select
          value={filter}
          onChange={setFilter}
          options={statusOptions}
          ariaLabel={t("field.status")}
          className="w-full sm:w-auto"
        />
      </div>

      {loaded && visible.length === 0 ? (
        <div className="rounded-card border border-line bg-surface px-6 py-10 text-center">
          <p className="text-sm font-medium text-ink">
            {debouncedQuery.trim() ? t("search.noResults", { query: debouncedQuery.trim() }) : t("invoice.empty")}
          </p>
          {!debouncedQuery.trim() && <p className="mt-1 text-sm text-muted">{t("invoice.emptyHint")}</p>}
        </div>
      ) : (
        <div role="region" tabIndex={0} aria-label={t("invoice.title")} className="relative overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th scope="col" className="px-4 py-3 font-medium">{t("invoice.number")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("invoice.member")}</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">{t("invoice.total")}</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">{t("invoice.paid")}</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">{t("invoice.balance")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("invoice.dueDate")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.status")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((inv) => {
                const effective = effectiveInvoiceStatus(inv, now);
                return (
                  <tr
                    key={inv.id}
                    onClick={() => openDetail(inv)}
                    className="cursor-pointer border-b border-line last:border-b-0 transition-colors duration-200 hover:bg-plum-50"
                  >
                    <td className="px-4 py-3 font-medium text-ink whitespace-nowrap">{inv.number}</td>
                    <td className="px-4 py-3 text-ink">{memberById.get(inv.memberId)?.name ?? ""}</td>
                    <td className="px-4 py-3 text-right text-ink whitespace-nowrap">{formatMoney(inv.total, locale)}</td>
                    <td className="px-4 py-3 text-right text-ink whitespace-nowrap">{formatMoney(inv.paidAmount, locale)}</td>
                    <td className="px-4 py-3 text-right text-ink whitespace-nowrap">{formatMoney(inv.total - inv.paidAmount, locale)}</td>
                    <td className="px-4 py-3 text-muted whitespace-nowrap">{formatDate(inv.dueDate, locale)}</td>
                    <td className="px-4 py-3"><StatusPill status={effective} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <GuideDialog open={guideOpen} section="invoices" onClose={() => setGuideOpen(false)} />

      <Modal open={createOpen} onOpenChange={setCreateOpen} title={t("invoice.create")} width="md:max-w-2xl">
        <div className="flex flex-col gap-4">
          <Field label={t("field.member")} htmlFor="invoice-member">
            <Select
              value={formMemberId}
              onChange={(v) => void pickMember(v)}
              options={[
                { value: "", label: t("field.member") },
                ...members.map((m) => ({ value: m.id, label: m.name })),
              ]}
              ariaLabel={t("field.member")}
              className="w-full"
            />
          </Field>
          <Field label={t("field.course")} htmlFor="invoice-enrollment">
            <Select
              value={formEnrollmentId}
              onChange={pickEnrollment}
              options={[
                { value: "", label: t("diff.none") },
                ...formEnrollments.map((e) => ({ value: e.id, label: courseById.get(e.courseId)?.title ?? e.courseId })),
              ]}
              ariaLabel={t("field.course")}
              className="w-full"
            />
          </Field>
          <Field label={t("field.dueDate")} htmlFor="invoice-due-date" hint={t("hint.invoiceDueDate")}>
            <DatePicker id="invoice-due-date" value={formDueDate} onChange={(v) => v && setFormDueDate(v)} />
          </Field>
          <Field label={t("field.status")} htmlFor="invoice-status">
            <Select
              value={formStatus}
              onChange={setFormStatus}
              options={[
                { value: "draft", label: t("status.draft") },
                { value: "sent", label: t("status.sent") },
              ]}
              ariaLabel={t("field.status")}
              className="w-full"
            />
          </Field>
          <Field label={t("field.method")} htmlFor="invoice-payment-method">
            <Select
              value={formPaymentMethod}
              onChange={setFormPaymentMethod}
              options={[
                { value: "cash", label: t("method.cash") },
                { value: "transfer", label: t("method.transfer") },
                { value: "other", label: t("method.other") },
              ]}
              ariaLabel={t("field.method")}
              className="w-full"
            />
          </Field>
          {formPaymentMethod !== "cash" && (
            <Field label={t("invoice.paymentDetails")} htmlFor="invoice-payment-details" hint={t("hint.paymentDetails")}>
              <input
                id="invoice-payment-details"
                type="text"
                value={formPaymentDetails}
                onChange={(e) => setFormPaymentDetails(e.target.value)}
                maxLength={200}
                className={`${inputClass} h-10`}
              />
            </Field>
          )}
          <Field label={t("invoice.charges")} hint={t("hint.invoiceCharges")}>
            <div className="flex flex-col gap-2">
              {formLines.map((line, i) => (
                <div key={i} className="flex flex-col gap-2 rounded-control border border-line bg-canvas/60 p-3">
                  <input
                    type="text"
                    value={line.description}
                    onChange={(e) => setLine(i, { description: e.target.value })}
                    placeholder={t("field.description")}
                    aria-label={t("field.description")}
                    className={`${inputClass} h-10 w-full`}
                  />
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      inputMode="decimal"
                      value={line.amount}
                      onChange={(e) => setLine(i, { amount: e.target.value })}
                      placeholder={t("field.amount")}
                      aria-label={t("field.amount")}
                      className={`${inputClass} h-10 w-40`}
                    />
                    <span className="text-xs text-muted">{currency}</span>
                    <button
                      type="button"
                      onClick={() => removeLine(i)}
                      disabled={formLines.length === 1}
                      aria-label={t("action.delete")}
                      className="ml-auto grid size-10 max-sm:size-11 shrink-0 place-items-center rounded-control text-muted transition-colors duration-200 hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                </div>
              ))}
              <div>
                <Button className="max-sm:min-h-11" variant="soft" icon="plus" onClick={() => setFormLines((lines) => [...lines, { description: "", amount: "" }])}>
                  {t("invoice.addCharge")}
                </Button>
              </div>
            </div>
          </Field>
          <Field label={t("attachment.title")}>
            <div className="flex flex-col gap-2">
              <AttachmentUploader
                entityType="invoice"
                entityId={null}
                onPending={(prepared) => setPendingAttachments((prev) => [...prev, { key: createId(), prepared }])}
              />
              {pendingAttachments.length > 0 && <p className="text-xs text-muted">{t("attachment.pendingHint")}</p>}
              <AttachmentThumbnails
                items={pendingThumbs}
                onRemove={(item) => setPendingAttachments((prev) => prev.filter((p) => p.key !== item.key))}
              />
            </div>
          </Field>
          <div className="flex items-center justify-between rounded-control bg-plum-50 px-4 py-3">
            <span className="text-sm font-medium text-ink">{t("invoice.total")}</span>
            <span className="text-sm font-semibold text-plum-900">{formatMoney(formTotal, locale)}</span>
          </div>
          {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
          <div className="flex justify-end gap-2">
            <Button className="max-sm:min-h-11" variant="ghost" onClick={() => setCreateOpen(false)}>{t("action.cancel")}</Button>
            <Button className="max-sm:min-h-11" onClick={() => void submitCreate()}>{t("invoice.create")}</Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={detail !== null}
        onOpenChange={(open) => { if (!open) setDetail(null); }}
        title={detail ? detail.number : t("invoice.title")}
        width="md:max-w-2xl"
      >
        {detail && (
          <div className="flex flex-col gap-5">
            <dl className="grid grid-cols-2 gap-3 text-sm max-sm:grid-cols-1">
              <div>
                <dt className="text-muted">{t("invoice.member")}</dt>
                <dd className="font-medium text-ink">{memberById.get(detail.memberId)?.name ?? ""}</dd>
              </div>
              <div>
                <dt className="text-muted">{t("invoice.dueDate")}</dt>
                <dd className="font-medium text-ink">{formatDate(detail.dueDate, locale)}</dd>
              </div>
              <div>
                <dt className="text-muted">{t("invoice.total")}</dt>
                <dd className="font-medium text-ink">{formatMoney(detail.total, locale)}</dd>
              </div>
              <div>
                <dt className="text-muted">{t("invoice.paid")}</dt>
                <dd className="font-medium text-ink">{formatMoney(detail.paidAmount, locale)}</dd>
              </div>
              <div>
                <dt className="text-muted">{t("invoice.balance")}</dt>
                <dd className="font-medium text-ink">{formatMoney(detailRemaining, locale)}</dd>
              </div>
              <div>
                <dt className="text-muted">{t("field.status")}</dt>
                <dd className="mt-0.5">{detailEffective && <StatusPill status={detailEffective} />}</dd>
              </div>
              <div>
                <dt className="text-muted">{t("field.method")}</dt>
                <dd className="font-medium text-ink">{t(`method.${paymentMethodOf(detail)}` as MessageKey)}</dd>
              </div>
              {paymentMethodOf(detail) !== "cash" && paymentDetailsOf(detail) && (
                <div>
                  <dt className="text-muted">{t("invoice.paymentDetails")}</dt>
                  <dd className="font-medium text-ink break-words">{paymentDetailsOf(detail)}</dd>
                </div>
              )}
            </dl>

            <div>
              <h2 className="text-sm font-medium text-ink">{t("invoice.charges")}</h2>
              <ul className="mt-2 flex flex-col gap-1.5">
                {detail.lineItems.map((item, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 rounded-control bg-plum-50 px-3 py-2 text-sm">
                    <span className="text-ink">{item.description}</span>
                    <span className="font-medium text-ink whitespace-nowrap">{formatMoney(item.amount, locale)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h2 className="text-sm font-medium text-ink">{t("attachment.title")}</h2>
              <div className="mt-2 flex flex-col gap-2">
                <AttachmentUploader
                  entityType="invoice"
                  entityId={detail.id}
                  onStored={() => void loadAttachmentRows(detail.id)}
                />
                {attachmentRows.length === 0 ? (
                  <p className="text-sm text-muted">{t("attachment.empty")}</p>
                ) : (
                  <AttachmentThumbnails
                    items={storedThumbs}
                    onOpen={(item) => {
                      const row = attachmentRows.find((r) => r.id === item.key);
                      if (row) setLightboxAttachment(row);
                    }}
                    onRemove={(item) => {
                      const row = attachmentRows.find((r) => r.id === item.key);
                      if (row) setConfirmDeleteAttachment(row);
                    }}
                  />
                )}
              </div>
            </div>

            <div>
              <h2 className="text-sm font-medium text-ink">{t("payment.title")}</h2>
              {detailPayments.length === 0 ? (
                <p className="mt-2 text-sm text-muted">{t("payment.empty")}</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {detailPayments.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 rounded-control border border-line px-3 py-2 text-sm">
                      <span className="text-ink">
                        {formatMoney(p.amount, locale)}
                        <span className="text-muted"> · {t(`method.${paymentMethodValue(p.method)}` as MessageKey)} · {formatDate(dateOf(p.at), locale)}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setConfirmDeletePayment(p)}
                        aria-label={t("payment.delete")}
                        className="grid size-8 max-sm:size-11 shrink-0 place-items-center rounded-full text-muted transition-colors duration-200 hover:bg-danger/10 hover:text-danger"
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {canPay && (
              <div className="rounded-control border border-line p-4">
                <h2 className="text-sm font-medium text-ink">{t("invoice.pay")}</h2>
                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
                  <div className="flex-1">
                    <Field label={t("invoice.paymentAmount")} htmlFor="payment-amount" hint={t("hint.paymentAmount")}>
                      <input
                        id="payment-amount"
                        type="number"
                        min={0}
                        max={detailRemaining}
                        inputMode="decimal"
                        value={payAmount}
                        onChange={(e) => setPayAmount(e.target.value)}
                        placeholder={formatMoney(detailRemaining, locale)}
                        className={`${inputClass} h-10`}
                      />
                    </Field>
                  </div>
                  <div className="sm:w-44">
                    <Field label={t("field.method")} htmlFor="payment-method">
                      <Select
                        value={payMethod}
                        onChange={setPayMethod}
                        options={[
                          { value: "cash", label: t("method.cash") },
                          { value: "transfer", label: t("method.transfer") },
                          { value: "other", label: t("method.other") },
                        ]}
                        ariaLabel={t("field.method")}
                        className="w-full"
                      />
                    </Field>
                  </div>
                  <Button className="max-sm:min-h-11" onClick={submitPayment}>{t("invoice.pay")}</Button>
                </div>
                {payError && <p role="alert" className="mt-2 text-sm text-danger">{payError}</p>}
                <div className="mt-3">
                  <Button className="max-sm:min-h-11" variant="soft" onClick={() => void record(detailRemaining, paymentMethodOf(detail))}>
                    {t("invoice.markPaid")}
                  </Button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
              <Button className="max-sm:min-h-11" variant="ghost" onClick={() => setDetail(null)}>{t("action.close")}</Button>
              <Button className="max-sm:min-h-11" variant="soft" icon="receipt" onClick={() => setPrintOpen(true)}>{t("invoice.print")}</Button>
              <Button className="max-sm:min-h-11" variant="soft" icon="pencil" onClick={() => openEdit(detail)}>{t("invoice.edit")}</Button>
              <Button className="max-sm:min-h-11" variant="dangerSoft" icon="trash" onClick={() => setConfirmDelete(detail)}>{t("invoice.delete")}</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={printOpen && detail !== null}
        onOpenChange={(open) => { if (!open) setPrintOpen(false); }}
        title={t("invoice.printTitle")}
        width="md:max-w-2xl"
      >
        {detail && (
          <div className="flex flex-col gap-4">
            <div ref={docRef} className="overflow-x-auto">
              <InvoiceDocument
                invoice={detail}
                memberName={memberById.get(detail.memberId)?.name ?? ""}
                attachments={printableAttachments}
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button className="max-sm:min-h-11"
                icon="download"
                disabled={exporting}
                onClick={() => void runExport("pdf")}
              >
                {t("invoice.downloadPdf")}
              </Button>
              <Button className="max-sm:min-h-11"
                variant="soft"
                icon="download"
                disabled={exporting}
                onClick={() => void runExport("png")}
              >
                {t("invoice.downloadPng")}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={edit !== null} onOpenChange={(open) => { if (!open) setEdit(null); }} title={t("invoice.edit")}>
        {edit && (
          <div className="flex flex-col gap-4">
            <Field label={t("field.dueDate")} htmlFor="edit-due-date" hint={t("hint.invoiceDueDate")}>
              <DatePicker id="edit-due-date" value={editDueDate} onChange={(v) => v && setEditDueDate(v)} />
            </Field>
            <Field label={t("field.status")} htmlFor="edit-status">
              {edit.status === "draft" || edit.status === "sent" ? (
                <Select
                  value={editStatus}
                  onChange={setEditStatus}
                  options={[
                    { value: "draft", label: t("status.draft") },
                    { value: "sent", label: t("status.sent") },
                  ]}
                  ariaLabel={t("field.status")}
                  className="w-full"
                />
              ) : (
                <p className="flex h-10 items-center text-sm text-ink">
                  {t(`status.${edit.status}` as MessageKey)}
                </p>
              )}
            </Field>
            <Field label={t("field.method")} htmlFor="edit-payment-method">
              <Select
                value={editPaymentMethod}
                onChange={setEditPaymentMethod}
                options={[
                  { value: "cash", label: t("method.cash") },
                  { value: "transfer", label: t("method.transfer") },
                  { value: "other", label: t("method.other") },
                ]}
                ariaLabel={t("field.method")}
                className="w-full"
              />
            </Field>
            {editPaymentMethod !== "cash" && (
              <Field label={t("invoice.paymentDetails")} htmlFor="edit-payment-details" hint={t("hint.paymentDetails")}>
                <input
                  id="edit-payment-details"
                  type="text"
                  value={editPaymentDetails}
                  onChange={(e) => setEditPaymentDetails(e.target.value)}
                  maxLength={200}
                  className={`${inputClass} h-10`}
                />
              </Field>
            )}
            <Field label={t("attachment.title")}>
              <div className="flex flex-col gap-2">
                <AttachmentUploader
                  entityType="invoice"
                  entityId={edit.id}
                  onStored={() => void loadAttachmentRows(edit.id)}
                />
                {attachmentRows.length === 0 ? (
                  <p className="text-sm text-muted">{t("attachment.empty")}</p>
                ) : (
                  <AttachmentThumbnails
                    items={storedThumbs}
                    onOpen={(item) => {
                      const row = attachmentRows.find((r) => r.id === item.key);
                      if (row) setLightboxAttachment(row);
                    }}
                    onRemove={(item) => {
                      const row = attachmentRows.find((r) => r.id === item.key);
                      if (row) setConfirmDeleteAttachment(row);
                    }}
                  />
                )}
              </div>
            </Field>
            {editError && <p role="alert" className="text-sm text-danger">{editError}</p>}
            <div className="flex justify-end gap-2">
              <Button className="max-sm:min-h-11" variant="ghost" onClick={() => setEdit(null)}>{t("action.cancel")}</Button>
              <Button className="max-sm:min-h-11" onClick={() => void submitEdit()}>{t("action.save")}</Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("invoice.delete")}
        body={confirmDelete ? t("invoice.deleteBody", { number: confirmDelete.number }) : ""}
        confirmLabel={t("action.delete")}
        cancelLabel={t("action.cancel")}
        danger
        onConfirm={() => void submitDelete()}
        onCancel={() => setConfirmDelete(null)}
      />

      <ConfirmDialog
        open={confirmDeletePayment !== null}
        title={t("payment.delete")}
        body={confirmDeletePayment ? t("payment.deleteBody", { amount: formatMoney(confirmDeletePayment.amount, locale) }) : ""}
        confirmLabel={t("action.delete")}
        cancelLabel={t("action.cancel")}
        danger
        onConfirm={() => void submitDeletePayment()}
        onCancel={() => setConfirmDeletePayment(null)}
      />

      <AttachmentLightbox
        open={lightboxAttachment !== null}
        attachment={lightboxAttachment}
        blob={lightboxAttachment ? (attachmentBlobs.get(lightboxAttachment.id) ?? null) : null}
        onClose={() => setLightboxAttachment(null)}
        onDelete={(att) => void removeAttachment(att)}
      />

      <ConfirmDialog
        open={confirmDeleteAttachment !== null}
        title={t("attachment.delete")}
        body={confirmDeleteAttachment ? t("attachment.deleteBody", { fileName: confirmDeleteAttachment.fileName }) : ""}
        confirmLabel={t("action.delete")}
        cancelLabel={t("action.cancel")}
        danger
        onConfirm={() => confirmDeleteAttachment && void removeAttachment(confirmDeleteAttachment)}
        onCancel={() => setConfirmDeleteAttachment(null)}
      />
    </div>
  );
}
