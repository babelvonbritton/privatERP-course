import type { Translate } from "@/i18n";
import type { MessageKey } from "@/i18n/types";
import { ValidationError } from "@/lib/storage/Guard";
import type { AppError } from "./AppError";
import { getCurrency } from "@/lib/currency";

/** Technical field names used by validation, mapped to their translated labels. */
const FIELD_KEYS: Record<string, MessageKey> = {
  name: "field.name",
  email: "field.email",
  phone: "field.phone",
  notes: "field.notes",
  status: "field.status",
  subjects: "field.subjects",
  ratePerSession: "field.ratePerSession",
  title: "field.title",
  description: "field.description",
  level: "field.level",
  price: "field.price",
  capacity: "field.capacity",
  trainerId: "field.trainer",
  scheduleWeekdays: "field.scheduleWeekdays",
  startTime: "field.startTime",
  endTime: "field.endTime",
  memberId: "field.member",
  courseId: "field.course",
  startDate: "field.startDate",
  endDate: "field.endDate",
  date: "field.date",
  topic: "field.topic",
  trainerPresent: "field.trainerPresent",
  lineItems: "invoice.charges",
  dueDate: "field.dueDate",
  amount: "field.amount",
  method: "field.method",
  periodStart: "field.periodStart",
  periodEnd: "field.periodEnd",
};

/** User-facing title and hint for an error, in the active language. */
export function describeError(error: AppError, t: Translate): { title: string; hint: string } {
  const title = t(`err.${error.code}.title` as MessageKey);
  const cause = error.cause;
  if (error.code === "VALIDATION" && cause instanceof ValidationError) {
    const key = FIELD_KEYS[cause.field];
    const vars: Record<string, string | number> = {
      field: key ? t(key, { currency: getCurrency() }) : cause.field,
      limit: cause.limit ?? 0,
      ...(cause.vars ?? {}),
    };
    // The service carries allowed weekdays as numbers, so they stay correct in every language; translate them here.
    if (cause.kind === "notScheduledDay" && typeof cause.vars?.days === "string") {
      vars.days = cause.vars.days
        .split(",")
        .map((n) => t(`weekday.${n}` as MessageKey))
        .join(", ");
    }
    return { title, hint: t(`validation.${cause.kind}`, vars) };
  }
  return { title, hint: t(`err.${error.code}.hint` as MessageKey, error.context) };
}
