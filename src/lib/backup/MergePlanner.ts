import type { Msg } from "@/i18n/types";
import type { BackupData } from "@/lib/domain/types";
import { STORE_NAMES, type StoreName } from "./constants";

export type Decision = "replace" | "skip";
export type EntityKind =
  | "member"
  | "trainer"
  | "course"
  | "enrollment"
  | "session"
  | "attendance"
  | "invoice"
  | "payment"
  | "payrollRun"
  | "auditLog"
  | "writeKey"
  | "setting";

export type EntryStatus = "new" | "same" | "differs";
export type DiffField =
  | "name"
  | "email"
  | "phone"
  | "status"
  | "title"
  | "description"
  | "level"
  | "price"
  | "capacity"
  | "trainer"
  | "schedule"
  | "member"
  | "course"
  | "date"
  | "startDate"
  | "endDate"
  | "topic"
  | "number"
  | "total"
  | "paid"
  | "dueDate"
  | "amount"
  | "method"
  | "period"
  | "sessions"
  | "value"
  | "notes"
  | "rate"
  | "subjects";
export type DiffValue =
  | { kind: "text"; value: string }
  | { kind: "date"; value: string }
  | { kind: "money"; value: number }
  | { kind: "status"; value: string }
  | { kind: "long"; value: string };
export interface FieldDiff {
  field: DiffField;
  current: DiffValue;
  incoming: DiffValue;
}
export interface MergeEntry {
  key: string;
  kind: EntityKind;
  id: string;
  status: EntryStatus;
  name: string;
  diffs: FieldDiff[];
}

export interface KindCounts { new: number; same: number; differs: number }
export interface MergePlan {
  entries: MergeEntry[];
  totals: KindCounts;
  byKind: Record<EntityKind, KindCounts>;
}
export type Decisions = ReadonlyMap<string, Decision>;
export interface MergeResult {
  data: BackupData;
  total: number;
  added: number;
  replaced: number;
  kept: number;
  /** Inspection warnings carried through, such as attachment files missing from the backup. */
  warnings: Msg[];
}

/** One of the record's fields, compared as text, a date, money, or a status. */
interface FieldSpec<T> {
  field: DiffField;
  kind: DiffValue["kind"];
  get: (v: T) => string | number;
}

const text = (v: string): DiffValue => ({ kind: "text", value: v });
const long = (v: string): DiffValue => ({ kind: "long", value: v });
const date = (v: string): DiffValue => ({ kind: "date", value: v });
const money = (v: number): DiffValue => ({ kind: "money", value: v });
const status = (v: string): DiffValue => ({ kind: "status", value: v });

function makeValue(kind: DiffValue["kind"], v: string | number): DiffValue {
  return kind === "money" ? money(v as number) : kind === "date" ? date(String(v)) : kind === "status" ? status(String(v)) : kind === "long" ? long(String(v)) : text(String(v));
}

/** Compares incoming records with the current ones, field by field, and shows only real differences. */
export class MergePlanner {
  static plan(current: BackupData, incoming: BackupData): MergePlan {
    const entries: MergeEntry[] = [];
    const byKind = {} as Record<EntityKind, KindCounts>;
    const totals: KindCounts = { new: 0, same: 0, differs: 0 };

    const classify = <T>(kind: EntityKind, idOf: (v: T) => string, nameOf: (v: T) => string, specs: FieldSpec<T>[], cur: T[], inc: T[], opts?: { appendOnly?: boolean }) => {
      const currentMap = new Map(cur.map((v) => [idOf(v), v]));
      const counts: KindCounts = { new: 0, same: 0, differs: 0 };
      for (const v of inc) {
        const c = currentMap.get(idOf(v));
        if (!c) {
          entries.push({ key: `${kind}:${idOf(v)}`, kind, id: idOf(v), status: "new", name: nameOf(v), diffs: [] });
          counts.new++;
          continue;
        }
        const diffs: FieldDiff[] = [];
        for (const spec of specs) {
          const cv = spec.get(c);
          const iv = spec.get(v);
          if (cv !== iv) diffs.push({ field: spec.field, current: makeValue(spec.kind, cv), incoming: makeValue(spec.kind, iv) });
        }
        if (diffs.length === 0 || opts?.appendOnly) {
          entries.push({ key: `${kind}:${idOf(v)}`, kind, id: idOf(v), status: "same", name: nameOf(v), diffs: [] });
          counts.same++;
        } else {
          entries.push({ key: `${kind}:${idOf(v)}`, kind, id: idOf(v), status: "differs", name: nameOf(v), diffs });
          counts.differs++;
        }
      }
      byKind[kind] = counts;
      totals.new += counts.new;
      totals.same += counts.same;
      totals.differs += counts.differs;
    };

    const byId = <T extends { id: string }>(v: T) => v.id;

    classify("member", byId, (v) => v.name, [
      { field: "name", kind: "text", get: (v) => v.name },
      { field: "email", kind: "text", get: (v) => v.email },
      { field: "phone", kind: "text", get: (v) => v.phone },
      { field: "notes", kind: "long", get: (v) => v.notes },
      { field: "status", kind: "status", get: (v) => v.status },
    ], current.members, incoming.members);

    classify("trainer", byId, (v) => v.name, [
      { field: "name", kind: "text", get: (v) => v.name },
      { field: "email", kind: "text", get: (v) => v.email },
      { field: "phone", kind: "text", get: (v) => v.phone },
      { field: "subjects", kind: "text", get: (v) => v.subjects.join(", ") },
      { field: "rate", kind: "money", get: (v) => v.ratePerSession },
      { field: "status", kind: "status", get: (v) => v.status },
    ], current.trainers, incoming.trainers);

    classify("course", byId, (v) => v.title, [
      { field: "title", kind: "text", get: (v) => v.title },
      { field: "description", kind: "long", get: (v) => v.description },
      { field: "level", kind: "text", get: (v) => v.level },
      { field: "price", kind: "money", get: (v) => v.price },
      { field: "capacity", kind: "text", get: (v) => String(v.capacity) },
      { field: "trainer", kind: "text", get: (v) => v.trainerId },
      { field: "schedule", kind: "text", get: (v) => `${v.scheduleWeekday} ${v.scheduleTime}` },
      { field: "status", kind: "status", get: (v) => v.status },
    ], current.courses, incoming.courses);

    classify("enrollment", byId, (v) => `${v.memberId} / ${v.courseId}`, [
      { field: "startDate", kind: "date", get: (v) => v.startDate },
      { field: "endDate", kind: "date", get: (v) => v.endDate ?? "" },
      { field: "status", kind: "status", get: (v) => v.status },
    ], current.enrollments, incoming.enrollments);

    classify("session", byId, (v) => `${v.date} ${v.topic}`, [
      { field: "date", kind: "date", get: (v) => v.date },
      { field: "topic", kind: "text", get: (v) => v.topic },
      { field: "trainer", kind: "text", get: (v) => v.trainerId },
      { field: "status", kind: "text", get: (v) => (v.trainerPresent ? "present" : "absent") },
    ], current.sessions, incoming.sessions);

    classify("attendance", byId, (v) => `${v.sessionId} / ${v.memberId}`, [
      { field: "status", kind: "status", get: (v) => v.status },
    ], current.attendance, incoming.attendance);

    classify("invoice", byId, (v) => v.number, [
      { field: "number", kind: "text", get: (v) => v.number },
      { field: "member", kind: "text", get: (v) => v.memberId },
      { field: "total", kind: "money", get: (v) => v.total },
      { field: "paid", kind: "money", get: (v) => v.paidAmount },
      { field: "dueDate", kind: "date", get: (v) => v.dueDate },
      { field: "status", kind: "status", get: (v) => v.status },
    ], current.invoices, incoming.invoices);

    classify("payment", byId, (v) => `${v.invoiceId} ${v.amount}`, [
      { field: "amount", kind: "money", get: (v) => v.amount },
      { field: "date", kind: "date", get: (v) => new Date(v.at).toISOString().slice(0, 10) },
      { field: "method", kind: "text", get: (v) => v.method },
    ], current.payments, incoming.payments);

    classify("payrollRun", byId, (v) => `${v.trainerId} ${v.periodStart}`, [
      { field: "period", kind: "date", get: (v) => `${v.periodStart} – ${v.periodEnd}` },
      { field: "sessions", kind: "text", get: (v) => String(v.sessionCount) },
      { field: "rate", kind: "money", get: (v) => v.ratePerSession },
      { field: "total", kind: "money", get: (v) => v.total },
      { field: "status", kind: "status", get: (v) => v.status },
    ], current.payrollRuns, incoming.payrollRuns);

    // The audit log and idempotency keys are append-only history: never replaced, only added.
    classify("auditLog", byId, (v) => `${v.entity} ${v.action}`, [], current.auditLog, incoming.auditLog, { appendOnly: true });
    classify("writeKey", (v) => v.key, (v) => v.key, [], current.writeKeys, incoming.writeKeys, { appendOnly: true });

    classify("setting", (v) => v.key, (v) => v.key, [
      { field: "value", kind: "text", get: (v) => String(v.value ?? "") },
    ], current.settings, incoming.settings);

    return { entries, totals, byKind };
  }

  /** Applies the chosen decisions and returns the merged records. New records are always added; differing records are replaced only when the user chose "replace". */
  static resolve(current: BackupData, incoming: BackupData, decisions: Decisions, _now: number): MergeResult {
    const out = structuredClone(current);
    out.attachments = out.attachments ?? [];
    const incomingAttachments = incoming.attachments ?? [];
    let added = 0;
    let replaced = 0;
    let kept = 0;
    const apply = <T extends { id: string }>(store: StoreName, kind: string, list: T[]) => {
      const target = out[store] as unknown as T[];
      const existing = new Set(target.map((t) => t.id));
      for (const v of list) {
        if (!existing.has(v.id)) {
          target.push(v);
          added++;
          continue;
        }
        if (decisions.get(`${kind}:${v.id}`) === "replace") {
          const idx = target.findIndex((t) => t.id === v.id);
          if (idx >= 0) target[idx] = v;
          replaced++;
        } else kept++;
      }
    };
    apply("members", "member", incoming.members);
    apply("trainers", "trainer", incoming.trainers);
    apply("courses", "course", incoming.courses);
    apply("enrollments", "enrollment", incoming.enrollments);
    apply("sessions", "session", incoming.sessions);
    apply("attendance", "attendance", incoming.attendance);
    apply("invoices", "invoice", incoming.invoices);
    apply("payments", "payment", incoming.payments);
    apply("payrollRuns", "payrollRun", incoming.payrollRuns);
    apply("auditLog", "auditLog", incoming.auditLog);
    // Settings are keyed by key, not by an id field.
    for (const s of incoming.settings) {
      const idx = out.settings.findIndex((t) => t.key === s.key);
      if (idx < 0) {
        out.settings.push(s);
        added++;
      } else if (decisions.get(`setting:${s.key}`) === "replace") {
        out.settings[idx] = s;
        replaced++;
      } else kept++;
    }
    // Idempotency keys are keyed by key, not by an id field; keep the ones that are new.
    const existingKeys = new Set(out.writeKeys.map((w) => w.key));
    for (const w of incoming.writeKeys) {
      if (!existingKeys.has(w.key)) {
        out.writeKeys.push(w);
        added++;
      }
    }
    // Attachments are append-only history like the audit log: new rows are
    // added, existing rows are never replaced. The merge review does not list
    // them; they ride along with the restored data.
    const existingAttachments = new Set(out.attachments.map((a) => a.id));
    for (const a of incomingAttachments) {
      if (!existingAttachments.has(a.id)) {
        out.attachments.push(a);
        added++;
      }
    }
    const total = STORE_NAMES.reduce((sum, n) => sum + (out[n] as unknown[]).length, 0) + out.attachments.length;
    return { data: out, total, added, replaced, kept, warnings: [] };
  }
}
