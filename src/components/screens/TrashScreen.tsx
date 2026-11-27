"use client";

import { useCallback, useState } from "react";
import { useI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/types";
import { getServices } from "@/lib/domain/services";
import { ORG_ID, OWNER_ID } from "@/lib/domain/types";
import { getStorage } from "@/lib/storage";
import { DEFAULT_BUSINESS_PROFILE, type BusinessProfile } from "@/lib/storage/BusinessProfileService";
import { trashDaysRemaining, type TrashEntry } from "@/lib/domain/trash";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { useLoadOnce } from "@/lib/hooks/useLoadOnce";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { isRealDate } from "@/lib/storage/utils";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";
import { GuideButton } from "../GuideButton";
import type { NavId } from "../nav";

type DetailTranslate = (key: MessageKey, vars?: Record<string, string | number>) => string;
type DetailHas = (key: string) => boolean;

const DATE_FIELDS = new Set(["date", "dueDate", "startDate", "endDate", "periodStart", "periodEnd"]);
const TIMESTAMP_FIELDS = new Set(["at", "createdAt", "updatedAt", "paidAt"]);
const MONEY_FIELDS = new Set(["amount", "paidAmount", "price", "ratePerSession", "total"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detailFieldLabel(field: string, t: DetailTranslate, has: DetailHas): string {
  const fieldKey = `trash.fields.${field}` as MessageKey;
  if (has(fieldKey)) return t(fieldKey);
  const commonFieldKey = `field.${field}` as MessageKey;
  if (has(commonFieldKey)) return t(commonFieldKey);
  return field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

function DetailValue({ value, field, t, has, locale }: { value: unknown; field: string; t: DetailTranslate; has: DetailHas; locale: string }) {
  if (value === null || value === undefined) return <span className="text-muted">{t("trash.emptyValue")}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted">{t("trash.emptyValue")}</span>;
    if (value.every(isRecord)) {
      return (
        <ul className="flex flex-col gap-2">
          {value.map((item, index) => (
            <li key={index} className="rounded-lg border border-line bg-canvas p-3">
              <DetailFields record={item} t={t} has={has} locale={locale} />
            </li>
          ))}
        </ul>
      );
    }
    return <span className="break-words">{value.map(String).join(", ")}</span>;
  }
  if (isRecord(value)) return <DetailFields record={value} t={t} has={has} locale={locale} />;
  if (typeof value === "boolean") return t(value ? "trash.yes" : "trash.no");
  if (typeof value === "number") {
    if (MONEY_FIELDS.has(field)) return formatMoney(value, locale);
    if (TIMESTAMP_FIELDS.has(field) && Number.isFinite(value)) {
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
    }
    return new Intl.NumberFormat(locale).format(value);
  }
  if (typeof value !== "string") return String(value);
  if (DATE_FIELDS.has(field) && isRealDate(value)) return formatDate(value, locale);
  const statusKey = `status.${value}` as MessageKey;
  if (field === "status" && has(statusKey)) return t(statusKey);
  const methodKey = `method.${value}` as MessageKey;
  if (field === "method" && has(methodKey)) return t(methodKey);
  return <span className="break-words">{value}</span>;
}

function DetailFields({ record, t, has, locale }: { record: Record<string, unknown>; t: DetailTranslate; has: DetailHas; locale: string }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {Object.entries(record).map(([field, value]) => (
        <div key={field} className="min-w-0">
          <dt className="text-xs font-medium text-muted">{detailFieldLabel(field, t, has)}</dt>
          <dd className="mt-1 text-sm text-ink">
            <DetailValue value={value} field={field} t={t} has={has} locale={locale} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The trash kind label: payroll runs use the "payroll" type name. */
function kindLabel(kind: TrashEntry["kind"], t: (key: MessageKey) => string): string {
  const key = kind === "payrollRun" ? "payroll" : kind;
  return t(`trash.types.${key}` as MessageKey);
}

/**
 * A trash snapshot shows the org/owner ids stamped when the record was
 * created, which predate the business profile. The detail view shows the
 * current profile names instead, falling back to the stamped ids and
 * then the constants when the profile field is empty. Stored records are
 * never rewritten; this only reshapes what the detail renders.
 */
function withCurrentProfileIds(value: unknown, profile: BusinessProfile): unknown {
  if (Array.isArray(value)) return value.map((item) => withCurrentProfileIds(item, profile));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (field === "orgId" && typeof fieldValue === "string") {
      out[field] = profile.businessName.trim() !== "" ? profile.businessName : fieldValue || ORG_ID;
    } else if (field === "ownerId" && typeof fieldValue === "string") {
      out[field] = profile.ownerName.trim() !== "" ? profile.ownerName : fieldValue || OWNER_ID;
    } else {
      out[field] = withCurrentProfileIds(fieldValue, profile);
    }
  }
  return out;
}

/** Trash screen: deleted records waiting out their retention window, with restore and permanent delete. */
export function TrashScreen({ navigate: _navigate }: { navigate: (id: NavId) => void }) {
  const { t, has, locale } = useI18n();
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [retentionDays, setRetentionDays] = useState(7);
  const [loaded, setLoaded] = useState(false);
  const [profile, setProfile] = useState<BusinessProfile>(DEFAULT_BUSINESS_PROFILE);
  const [detailTarget, setDetailTarget] = useState<TrashEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TrashEntry | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [list, days, { profile: stored }] = await Promise.all([
        getServices().trash.list(),
        getServices().trash.getRetentionDays(),
        getStorage().profile.load(),
      ]);
      setEntries(list);
      setRetentionDays(days);
      setProfile(stored);
    } catch (e) {
      errorCenter.report(e, { action: "trash.list" });
    }
  }, []);

  useLoadOnce(async (alive) => {
    try {
      await getServices().trash.purgeExpired();
    } catch (e) {
      errorCenter.report(e, { action: "trash.purge" });
    }
    if (!alive()) return;
    await load();
    if (alive()) setLoaded(true);
  }, "trash.purge", [load]);

  async function restoreEntry(entry: TrashEntry): Promise<void> {
    try {
      await getServices().trash.restore(entry.id);
      await load();
      errorCenter.notify({ key: "trash.restored", vars: { label: entry.label } });
    } catch (e) {
      errorCenter.report(e, { action: "trash.restore" });
    }
  }

  async function confirmDeletePermanently(): Promise<void> {
    if (!deleteTarget) return;
    try {
      await getServices().trash.deletePermanently(deleteTarget.id);
      setDeleteTarget(null);
      await load();
    } catch (e) {
      errorCenter.report(e, { action: "trash.delete" });
    }
  }

  async function confirmEmpty(): Promise<void> {
    try {
      await getServices().trash.empty();
      setEmptyOpen(false);
      await load();
    } catch (e) {
      errorCenter.report(e, { action: "trash.empty" });
    }
  }

  const detailSnapshot = detailTarget ? withCurrentProfileIds(detailTarget.snapshot, profile) : null;
  const detailRelated = detailTarget ? withCurrentProfileIds(detailTarget.related, profile) : null;

  return (
    <div data-tour="trash" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <h1 className="text-2xl font-semibold text-plum-900">{t("trash.title")}</h1>
          <GuideButton section="trash" />
        </div>
        {loaded && entries.length > 0 && (
          <Button className="max-sm:min-h-11" variant="dangerSoft" icon="trash" onClick={() => setEmptyOpen(true)}>
            {t("trash.emptyTrash")}
          </Button>
        )}
      </div>

      <p className="text-sm text-muted">{t("trash.hint", { days: retentionDays })}</p>

      {!loaded ? null : entries.length === 0 ? (
        <div className="rounded-card border border-line bg-surface px-6 py-10 text-center">
          <p className="text-sm font-medium text-ink">{t("trash.empty")}</p>
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{t("trash.item", { type: kindLabel(entry.kind, t), label: entry.label })}</p>
                <p className="mt-0.5 text-sm text-muted">
                  {t("trash.deletedOn", { date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(entry.deletedAt)) })}
                  {" · "}
                  {t("trash.daysLeft", { count: trashDaysRemaining(entry, retentionDays) })}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button className="max-sm:min-h-11" variant="ghost" onClick={() => setDetailTarget(entry)}>
                  {t("trash.viewDetails")}
                </Button>
                <Button className="max-sm:min-h-11" variant="soft" icon="restore" onClick={() => void restoreEntry(entry)}>
                  {t("trash.restore")}
                </Button>
                <Button className="max-sm:min-h-11" variant="dangerSoft" icon="trash" onClick={() => setDeleteTarget(entry)}>
                  {t("trash.deletePermanently")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={detailTarget !== null}
        onOpenChange={(open) => { if (!open) setDetailTarget(null); }}
        title={detailTarget?.label ?? ""}
        width="md:max-w-2xl"
      >
        {detailTarget && (
          <div className="flex flex-col gap-5">
            <p className="text-sm text-muted">
              {kindLabel(detailTarget.kind, t)}
              {" · "}
              {t("trash.deletedOn", { date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(detailTarget.deletedAt)) })}
            </p>
            <section>
              <h2 className="mb-3 text-sm font-semibold text-plum-900">{t("trash.detail")}</h2>
              {isRecord(detailSnapshot) ? (
                <DetailFields record={detailSnapshot} t={t} has={has} locale={locale} />
              ) : (
                <DetailValue value={detailSnapshot} field="snapshot" t={t} has={has} locale={locale} />
              )}
            </section>
            {detailTarget.related.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold text-plum-900">{t("trash.relatedData")}</h2>
                <DetailValue value={detailRelated} field="related" t={t} has={has} locale={locale} />
              </section>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("trash.deleteOneTitle")}
        body={deleteTarget ? t("trash.deleteOneBody", { label: deleteTarget.label }) : ""}
        confirmLabel={t("trash.deletePermanently")}
        cancelLabel={t("action.cancel")}
        danger
        onConfirm={() => void confirmDeletePermanently()}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={emptyOpen}
        title={t("trash.deleteTitle")}
        body={t("trash.deleteBody", { count: entries.length })}
        confirmLabel={t("trash.deletePermanently")}
        cancelLabel={t("action.cancel")}
        danger
        onConfirm={() => void confirmEmpty()}
        onCancel={() => setEmptyOpen(false)}
      />

    </div>
  );
}
