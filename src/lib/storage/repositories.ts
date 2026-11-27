import type { Table } from "dexie";
import { BaseRepository } from "./BaseRepository";
import type { TrashEntry } from "@/lib/domain/trash";
import type {
  Attendance,
  AuditLogEntry,
  Course,
  CourseStatus,
  Enrollment,
  EnrollmentStatus,
  Invoice,
  InvoiceStatus,
  Member,
  MemberStatus,
  Payment,
  PayrollRun,
  PayrollStatus,
  Session,
  SettingRecord,
  Trainer,
  TrainerStatus,
  WriteKey,
} from "@/lib/domain/types";

export interface MemberStore {
  get(id: string): Promise<Member | undefined>;
  all(): Promise<Member[]>;
  search(query: string): Promise<Member[]>;
  listByStatus(status: MemberStatus): Promise<Member[]>;
  put(record: Member): Promise<string>;
  remove(id: string): Promise<void>;
}

export interface TrainerStore {
  get(id: string): Promise<Trainer | undefined>;
  all(): Promise<Trainer[]>;
  search(query: string): Promise<Trainer[]>;
  listByStatus(status: TrainerStatus): Promise<Trainer[]>;
  put(record: Trainer): Promise<string>;
  remove(id: string): Promise<void>;
}

export interface CourseStore {
  get(id: string): Promise<Course | undefined>;
  all(): Promise<Course[]>;
  search(query: string): Promise<Course[]>;
  listByStatus(status: CourseStatus): Promise<Course[]>;
  put(record: Course): Promise<string>;
  remove(id: string): Promise<void>;
}

export interface EnrollmentStore {
  get(id: string): Promise<Enrollment | undefined>;
  all(): Promise<Enrollment[]>;
  listByMember(memberId: string): Promise<Enrollment[]>;
  listByCourse(courseId: string): Promise<Enrollment[]>;
  listActiveByCourse(courseId: string): Promise<Enrollment[]>;
  findActive(memberId: string, courseId: string): Promise<Enrollment | undefined>;
  put(record: Enrollment): Promise<string>;
  remove(id: string): Promise<void>;
}

export interface SessionStore {
  get(id: string): Promise<Session | undefined>;
  all(): Promise<Session[]>;
  listByCourse(courseId: string): Promise<Session[]>;
  findByCourseAndDate(courseId: string, date: string): Promise<Session | undefined>;
  listInRange(start: string, end: string): Promise<Session[]>;
  put(record: Session): Promise<string>;
  remove(id: string): Promise<void>;
}

export interface AttendanceStore {
  get(id: string): Promise<Attendance | undefined>;
  all(): Promise<Attendance[]>;
  listBySession(sessionId: string): Promise<Attendance[]>;
  find(sessionId: string, memberId: string): Promise<Attendance | undefined>;
  put(record: Attendance): Promise<string>;
  remove(id: string): Promise<void>;
}

export interface InvoiceStore {
  get(id: string): Promise<Invoice | undefined>;
  all(): Promise<Invoice[]>;
  search(query: string): Promise<Invoice[]>;
  listByMember(memberId: string): Promise<Invoice[]>;
  listByStatus(status: InvoiceStatus): Promise<Invoice[]>;
  numbersWithPrefix(prefix: string): Promise<string[]>;
  put(record: Invoice): Promise<string>;
  remove(id: string): Promise<void>;
}

export interface PaymentStore {
  get(id: string): Promise<Payment | undefined>;
  all(): Promise<Payment[]>;
  listByInvoice(invoiceId: string): Promise<Payment[]>;
  listInRange(startAt: number, endAt: number): Promise<Payment[]>;
  put(record: Payment): Promise<string>;
  remove(id: string): Promise<void>;
}

export interface PayrollStore {
  get(id: string): Promise<PayrollRun | undefined>;
  all(): Promise<PayrollRun[]>;
  listByTrainer(trainerId: string): Promise<PayrollRun[]>;
  findByTrainerAndPeriod(trainerId: string, periodStart: string): Promise<PayrollRun | undefined>;
  put(record: PayrollRun): Promise<string>;
  remove(id: string): Promise<void>;
}

export interface AuditStore {
  add(entry: AuditLogEntry): Promise<string>;
  listRecent(limit: number): Promise<AuditLogEntry[]>;
  all(): Promise<AuditLogEntry[]>;
}

export interface WriteKeyStore {
  get(key: string): Promise<WriteKey | undefined>;
  put(record: WriteKey): Promise<string>;
  all(): Promise<WriteKey[]>;
}

export interface SettingsStore {
  read(key: string): Promise<SettingRecord["value"] | undefined>;
  write(key: string, value: SettingRecord["value"]): Promise<void>;
  all(): Promise<SettingRecord[]>;
}

export interface TrashStore {
  get(id: string): Promise<TrashEntry | undefined>;
  all(): Promise<TrashEntry[]>;
  put(record: TrashEntry): Promise<string>;
  remove(id: string): Promise<void>;
}

/** Merges prefix matches from several indexes, de-duplicated by id. */
async function multiIndexSearch<T extends { id: string; name?: string; title?: string }>(
  table: Table<T, string>,
  fields: Array<keyof T & string>,
  query: string,
): Promise<T[]> {
  const q = query.trim();
  if (!q) return table.toArray();
  const found = new Map<string, T>();
  const lists = await Promise.all(fields.map((f) => table.where(f).startsWithIgnoreCase(q).toArray()));
  for (const list of lists) for (const r of list) found.set(r.id, r);
  const rows = [...found.values()];
  rows.sort((a, b) => (a.name ?? a.title ?? "").localeCompare(b.name ?? b.title ?? ""));
  return rows;
}

export class DexieMemberStore extends BaseRepository<Member, string> implements MemberStore {
  search(query: string): Promise<Member[]> {
    return multiIndexSearch(this.table, ["name", "email", "phone"], query);
  }
  listByStatus(status: MemberStatus): Promise<Member[]> {
    return this.table.where("status").equals(status).sortBy("name");
  }
}

export class DexieTrainerStore extends BaseRepository<Trainer, string> implements TrainerStore {
  search(query: string): Promise<Trainer[]> {
    return multiIndexSearch(this.table, ["name", "email", "phone"], query);
  }
  listByStatus(status: TrainerStatus): Promise<Trainer[]> {
    return this.table.where("status").equals(status).sortBy("name");
  }
}

export class DexieCourseStore extends BaseRepository<Course, string> implements CourseStore {
  search(query: string): Promise<Course[]> {
    return multiIndexSearch(this.table, ["title"], query);
  }
  listByStatus(status: CourseStatus): Promise<Course[]> {
    return this.table.where("status").equals(status).sortBy("title");
  }
}

export class DexieEnrollmentStore extends BaseRepository<Enrollment, string> implements EnrollmentStore {
  listByMember(memberId: string): Promise<Enrollment[]> {
    return this.table.where("memberId").equals(memberId).toArray();
  }
  listByCourse(courseId: string): Promise<Enrollment[]> {
    return this.table.where("courseId").equals(courseId).toArray();
  }
  listActiveByCourse(courseId: string): Promise<Enrollment[]> {
    return this.table.where({ courseId, status: "active" as EnrollmentStatus }).toArray();
  }
  async findActive(memberId: string, courseId: string): Promise<Enrollment | undefined> {
    return this.table.where({ memberId, courseId, status: "active" as EnrollmentStatus }).first();
  }
}

export class DexieSessionStore extends BaseRepository<Session, string> implements SessionStore {
  listByCourse(courseId: string): Promise<Session[]> {
    return this.table.where("courseId").equals(courseId).sortBy("date");
  }
  async findByCourseAndDate(courseId: string, date: string): Promise<Session | undefined> {
    return this.table.where({ courseId, date }).first();
  }
  listInRange(start: string, end: string): Promise<Session[]> {
    return this.table.where("date").between(start, end, true, true).toArray();
  }
}

export class DexieAttendanceStore extends BaseRepository<Attendance, string> implements AttendanceStore {
  listBySession(sessionId: string): Promise<Attendance[]> {
    return this.table.where("sessionId").equals(sessionId).toArray();
  }
  async find(sessionId: string, memberId: string): Promise<Attendance | undefined> {
    return this.table.where({ sessionId, memberId }).first();
  }
}

export class DexieInvoiceStore extends BaseRepository<Invoice, string> implements InvoiceStore {
  async search(query: string): Promise<Invoice[]> {
    const q = query.trim();
    const rows = q ? await this.table.where("number").startsWithIgnoreCase(q).sortBy("number") : await this.table.orderBy("number").toArray();
    return rows.reverse();
  }
  async listByMember(memberId: string): Promise<Invoice[]> {
    return (await this.table.where("memberId").equals(memberId).sortBy("number")).reverse();
  }
  async listByStatus(status: InvoiceStatus): Promise<Invoice[]> {
    return (await this.table.where("status").equals(status).sortBy("number")).reverse();
  }
  async numbersWithPrefix(prefix: string): Promise<string[]> {
    return (await this.table.where("number").startsWith(prefix).keys()) as string[];
  }
}

export class DexiePaymentStore extends BaseRepository<Payment, string> implements PaymentStore {
  listByInvoice(invoiceId: string): Promise<Payment[]> {
    return this.table.where("invoiceId").equals(invoiceId).sortBy("at");
  }
  listInRange(startAt: number, endAt: number): Promise<Payment[]> {
    return this.table.where("at").between(startAt, endAt, true, true).toArray();
  }
}

export class DexiePayrollStore extends BaseRepository<PayrollRun, string> implements PayrollStore {
  async listByTrainer(trainerId: string): Promise<PayrollRun[]> {
    return (await this.table.where("trainerId").equals(trainerId).sortBy("periodStart")).reverse();
  }
  async findByTrainerAndPeriod(trainerId: string, periodStart: string): Promise<PayrollRun | undefined> {
    return this.table.where({ trainerId, periodStart }).first();
  }
}

export class DexieAuditStore extends BaseRepository<AuditLogEntry, string> implements AuditStore {
  async add(entry: AuditLogEntry): Promise<string> {
    await this.table.add(entry);
    this.onWrite?.();
    return entry.id;
  }
  listRecent(limit: number): Promise<AuditLogEntry[]> {
    return this.table.orderBy("at").reverse().limit(limit).toArray();
  }
}

export class DexieWriteKeyStore extends BaseRepository<WriteKey, string> implements WriteKeyStore {
  async get(key: string): Promise<WriteKey | undefined> {
    return this.table.get(key);
  }
}

export class DexieSettingsStore extends BaseRepository<SettingRecord, string> implements SettingsStore {
  async read(key: string): Promise<SettingRecord["value"] | undefined> {
    return (await this.table.get(key))?.value;
  }
  async write(key: string, value: SettingRecord["value"]): Promise<void> {
    await this.table.put({ key, value });
  }
}

export class DexieTrashStore extends BaseRepository<TrashEntry, string> implements TrashStore {}
