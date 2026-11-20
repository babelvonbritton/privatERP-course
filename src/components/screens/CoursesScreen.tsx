"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/types";
import { getServices, today } from "@/lib/domain/services";
import type { Course, CourseStatus, CurrencyCode, Enrollment, Member, Session, Trainer } from "@/lib/domain/types";
import { formatMoney } from "@/lib/money";
import { getCurrency, subscribeCurrency } from "@/lib/currency";
import { formatDate } from "@/lib/dates";
import { createId } from "@/lib/storage/utils";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Field, inputClass } from "../ui/Field";
import { Select } from "../ui/Select";
import { SearchField } from "../ui/SearchField";
import { DatePicker } from "../ui/DatePicker";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/Icon";
import { GuideDialog } from "../GuideDialog";
import type { NavId } from "../nav";

/** Placeholder value for selects with nothing chosen yet. */
const NONE = "__none__";

interface CourseForm {
  title: string;
  description: string;
  level: string;
  price: string;
  capacity: string;
  trainerId: string;
  scheduleWeekday: string;
  scheduleTime: string;
  status: CourseStatus;
}

const emptyForm = (): CourseForm => ({
  title: "",
  description: "",
  level: "",
  price: "",
  capacity: "",
  trainerId: NONE,
  scheduleWeekday: "1",
  scheduleTime: "09:00",
  status: "active",
});

/** Course list with search, add and edit, plus a detail view for enrollments and sessions. */
export function CoursesScreen({ navigate: _navigate }: { navigate: (id: NavId) => void }) {
  const { t, locale } = useI18n();
  const [courses, setCourses] = useState<Course[]>([]);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [query, setQuery] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Course | null>(null);
  const [form, setForm] = useState<CourseForm>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Course | null>(null);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);

  const [showEnrollForm, setShowEnrollForm] = useState(false);
  const [enrollMemberId, setEnrollMemberId] = useState(NONE);
  const [enrollStart, setEnrollStart] = useState<string | null>(today());
  const [pendingEnrollment, setPendingEnrollment] = useState<Enrollment | null>(null);

  const [showSessionForm, setShowSessionForm] = useState(false);
  const [sessionDate, setSessionDate] = useState<string | null>(today());
  const [sessionTopic, setSessionTopic] = useState("");
  const [pendingSession, setPendingSession] = useState<Session | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);

  // The price label follows the current currency setting.
  const [currency, setCurrencyState] = useState<CurrencyCode>(() => getCurrency());
  useEffect(() => subscribeCurrency(() => setCurrencyState(getCurrency())), []);

  const trainerById = useMemo(() => new Map(trainers.map((tr) => [tr.id, tr])), [trainers]);
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const trainerName = useCallback((id: string) => trainerById.get(id)?.name ?? "", [trainerById]);
  const memberName = useCallback((id: string) => memberById.get(id)?.name ?? "", [memberById]);

  const load = useCallback(async (q: string) => {
    try {
      const s = getServices();
      const [found, trainerList, memberList] = await Promise.all([
        q.trim() ? s.courses.search(q.trim()) : s.courses.list(),
        s.trainers.list(),
        s.members.list(),
      ]);
      setCourses(found);
      setTrainers(trainerList);
      setMembers(memberList);
    } catch (e) {
      errorCenter.report(e, { action: "course.list" });
    }
  }, []);

  const loadDetail = useCallback(async (courseId: string) => {
    try {
      const s = getServices();
      const [foundEnrollments, foundSessions] = await Promise.all([
        s.courses.listEnrollmentsByCourse(courseId),
        s.attendance.listSessionsByCourse(courseId),
      ]);
      setEnrollments(foundEnrollments);
      setSessions([...foundSessions].sort((a, b) => b.date.localeCompare(a.date)));
    } catch (e) {
      errorCenter.report(e, { action: "course.detail" });
    }
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => {
      void load(query);
    }, 180);
    return () => clearTimeout(handle);
  }, [query, load]);

  const openDetail = (course: Course) => {
    setSelected(course);
    setShowEnrollForm(false);
    setShowSessionForm(false);
    void loadDetail(course.id);
  };

  const openAdd = () => {
    setEditing(null);
    setForm(emptyForm());
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (course: Course) => {
    setEditing(course);
    setForm({
      title: course.title,
      description: course.description,
      level: course.level,
      price: String(course.price),
      capacity: String(course.capacity),
      trainerId: course.trainerId,
      scheduleWeekday: String(course.scheduleWeekday),
      scheduleTime: course.scheduleTime,
      status: course.status,
    });
    setFormError(null);
    setFormOpen(true);
  };

  const submitCourse = async () => {
    if (!form.title.trim()) {
      setFormError(t("validation.required", { field: t("field.title") }));
      return;
    }
    if (!form.level.trim()) {
      setFormError(t("validation.required", { field: t("field.level") }));
      return;
    }
    if (form.trainerId === NONE) {
      setFormError(t("validation.required", { field: t("field.trainer") }));
      return;
    }
    const price = Number(form.price);
    if (!Number.isInteger(price) || price < 0) {
      setFormError(t("validation.invalid", { field: t("field.price", { currency }) }));
      return;
    }
    const capacity = Number(form.capacity);
    if (!Number.isInteger(capacity) || capacity < 1) {
      setFormError(t("validation.positive", { field: t("field.capacity") }));
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(form.scheduleTime)) {
      setFormError(t("validation.time", { field: t("field.scheduleTime") }));
      return;
    }
    try {
      const s = getServices();
      if (editing) {
        const updated = await s.courses.update(editing.id, {
          title: form.title.trim(),
          description: form.description,
          level: form.level.trim(),
          price,
          capacity,
          trainerId: form.trainerId,
          scheduleWeekday: Number(form.scheduleWeekday),
          scheduleTime: form.scheduleTime,
          status: form.status,
          idempotencyKey: createId(),
        });
        setSelected(updated);
        await loadDetail(editing.id);
      } else {
        await s.courses.create({
          title: form.title.trim(),
          description: form.description,
          level: form.level.trim(),
          price,
          capacity,
          trainerId: form.trainerId,
          scheduleWeekday: Number(form.scheduleWeekday),
          scheduleTime: form.scheduleTime,
          status: form.status,
          idempotencyKey: createId(),
        });
      }
      errorCenter.notify({ key: "toast.saved" });
      setFormOpen(false);
      setEditing(null);
      await load(query);
    } catch (e) {
      errorCenter.report(e, { action: editing ? "course.update" : "course.create" });
    }
  };

  const confirmDeleteCourse = async () => {
    if (!selected) return;
    try {
      await getServices().courses.remove(selected.id);
      errorCenter.notify({ key: "toast.deleted" });
      setDeleteOpen(false);
      setSelected(null);
      await load(query);
    } catch (e) {
      errorCenter.report(e, { action: "course.delete" });
    }
  };

  const eligibleMembers = useMemo(() => {
    const activeIds = new Set(enrollments.filter((e) => e.status === "active").map((e) => e.memberId));
    return members.filter((m) => !activeIds.has(m.id));
  }, [enrollments, members]);

  const submitEnroll = async () => {
    if (!selected || enrollMemberId === NONE || !enrollStart) return;
    try {
      await getServices().courses.enroll({
        memberId: enrollMemberId,
        courseId: selected.id,
        startDate: enrollStart,
        endDate: null,
        status: "active",
        idempotencyKey: createId(),
      });
      errorCenter.notify({ key: "toast.saved" });
      setShowEnrollForm(false);
      setEnrollMemberId(NONE);
      setEnrollStart(today());
      await loadDetail(selected.id);
    } catch (e) {
      errorCenter.report(e, { action: "enrollment.create" });
    }
  };

  const confirmDeleteEnrollment = async () => {
    if (!selected || !pendingEnrollment) return;
    try {
      await getServices().courses.removeEnrollment(pendingEnrollment.id);
      errorCenter.notify({ key: "toast.deleted" });
      setPendingEnrollment(null);
      await loadDetail(selected.id);
    } catch (e) {
      errorCenter.report(e, { action: "enrollment.delete" });
    }
  };

  const submitSession = async () => {
    if (!selected || !sessionDate || !sessionTopic.trim()) return;
    try {
      await getServices().attendance.createSession({
        courseId: selected.id,
        date: sessionDate,
        topic: sessionTopic.trim(),
        trainerId: selected.trainerId,
        trainerPresent: false,
        idempotencyKey: createId(),
      });
      errorCenter.notify({ key: "toast.saved" });
      setShowSessionForm(false);
      setSessionTopic("");
      setSessionDate(today());
      await loadDetail(selected.id);
    } catch (e) {
      errorCenter.report(e, { action: "session.create" });
    }
  };

  const confirmDeleteSession = async () => {
    if (!selected || !pendingSession) return;
    try {
      await getServices().attendance.removeSession(pendingSession.id);
      errorCenter.notify({ key: "toast.deleted" });
      setPendingSession(null);
      await loadDetail(selected.id);
    } catch (e) {
      errorCenter.report(e, { action: "session.delete" });
    }
  };

  return (
    <div data-tour="courses" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-1">
          <h1 className="text-2xl font-semibold text-plum-900">{t("course.title")}</h1>
          <button
            type="button"
            onClick={() => setGuideOpen(true)}
            aria-label={t("guide.open")}
            className="grid size-8 max-sm:size-11 shrink-0 place-items-center rounded-full text-muted transition-colors duration-200 hover:bg-plum-100 hover:text-ink"
          >
            <Icon name="help" size={18} />
          </button>
        </div>
        <Button className="max-sm:min-h-11" icon="plus" onClick={openAdd}>
          {t("course.add")}
        </Button>
      </div>

      <SearchField value={query} onChange={setQuery} placeholder={t("course.search")} clearLabel={t("search.clear")} className="w-full md:max-w-sm" />

      {courses.length === 0 ? (
        <div className="rounded-card border border-line bg-surface px-6 py-12 text-center">
          <p className="text-base font-medium text-ink">{t("course.empty")}</p>
          <p className="mt-1 text-sm text-muted">{t("course.emptyHint")}</p>
        </div>
      ) : (
        <div role="region" tabIndex={0} aria-label={t("course.title")} className="relative overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th scope="col" className="px-4 py-3 font-medium">{t("field.title")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.trainer")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.level")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.price", { currency })}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.capacity")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.status")}</th>
              </tr>
            </thead>
            <tbody>
              {courses.map((course) => (
                <tr
                  key={course.id}
                  tabIndex={0}
                  onClick={() => openDetail(course)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openDetail(course);
                    }
                  }}
                  className="cursor-pointer border-b border-line transition-colors duration-200 last:border-b-0 hover:bg-plum-50"
                >
                  <td className="px-4 py-3 font-medium text-ink">{course.title}</td>
                  <td className="px-4 py-3 text-ink">{trainerName(course.trainerId)}</td>
                  <td className="px-4 py-3 text-ink">{course.level}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-ink">{formatMoney(course.price, locale)}</td>
                  <td className="px-4 py-3 text-ink">{course.capacity}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium ${course.status === "active" ? "bg-plum-100 text-plum-900" : "bg-canvas text-muted"}`}>
                      {t(`status.${course.status}` as MessageKey)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <GuideDialog open={guideOpen} section="courses" onClose={() => setGuideOpen(false)} />

      <Modal
        open={formOpen}
        onOpenChange={setFormOpen}
        title={editing ? t("course.edit") : t("course.add")}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submitCourse();
          }}
        >
          <Field label={t("field.title")} htmlFor="course-title">
            <input id="course-title" className={inputClass} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          </Field>
          <Field label={t("field.description")} htmlFor="course-description">
            <textarea id="course-description" rows={3} className={`${inputClass} py-2`} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </Field>
          <Field label={t("field.level")} htmlFor="course-level">
            <input id="course-level" className={inputClass} value={form.level} onChange={(e) => setForm((f) => ({ ...f, level: e.target.value }))} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("field.price", { currency })} htmlFor="course-price" hint={t("hint.coursePrice")}>
              <input id="course-price" type="number" min={0} step={1} inputMode="numeric" className={inputClass} value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} />
            </Field>
            <Field label={t("field.capacity")} htmlFor="course-capacity" hint={t("hint.courseCapacity")}>
              <input id="course-capacity" type="number" min={1} step={1} inputMode="numeric" className={inputClass} value={form.capacity} onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))} />
            </Field>
          </div>
          <Field label={t("field.trainer")} htmlFor="course-trainer">
            <Select
              value={form.trainerId}
              onChange={(v) => setForm((f) => ({ ...f, trainerId: v }))}
              ariaLabel={t("field.trainer")}
              className="w-full"
              options={[{ value: NONE, label: t("field.trainer") }, ...trainers.map((tr) => ({ value: tr.id, label: tr.name }))]}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("field.scheduleWeekday")} htmlFor="course-weekday" hint={t("hint.courseSchedule")}>
              <Select
                value={form.scheduleWeekday}
                onChange={(v) => setForm((f) => ({ ...f, scheduleWeekday: v }))}
                ariaLabel={t("field.scheduleWeekday")}
                className="w-full"
                options={[0, 1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: t(`weekday.${n}` as MessageKey) }))}
              />
            </Field>
            <Field label={t("field.scheduleTime")} htmlFor="course-time">
              <input id="course-time" type="time" className={inputClass} value={form.scheduleTime} onChange={(e) => setForm((f) => ({ ...f, scheduleTime: e.target.value }))} />
            </Field>
          </div>
          <Field label={t("field.status")} htmlFor="course-status">
            <Select
              value={form.status}
              onChange={(v) => setForm((f) => ({ ...f, status: v as CourseStatus }))}
              ariaLabel={t("field.status")}
              className="w-full"
              options={([
                { value: "active", label: t("status.active") },
                { value: "archived", label: t("status.archived") },
              ] as const).map((o) => ({ value: o.value, label: o.label }))}
            />
          </Field>
          {formError && (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button className="max-sm:min-h-11" variant="ghost" onClick={() => setFormOpen(false)}>
              {t("action.cancel")}
            </Button>
            <Button className="max-sm:min-h-11" type="submit">{t("action.save")}</Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={selected?.title ?? ""}
        width="md:max-w-2xl"
      >
        {selected && (
          <div className="flex flex-col gap-6">
            <div>
              {selected.description && <p className="text-sm text-ink/90">{selected.description}</p>}
              <p className="mt-1 text-sm text-muted">
                {t(`weekday.${selected.scheduleWeekday}` as MessageKey)} {selected.scheduleTime} - {trainerName(selected.trainerId)} - {formatMoney(selected.price, locale)}
              </p>
              <div className="mt-3 flex gap-2">
                <Button className="max-sm:min-h-11" variant="soft" icon="pencil" onClick={() => openEdit(selected)}>
                  {t("course.edit")}
                </Button>
                <Button className="max-sm:min-h-11" variant="dangerSoft" icon="trash" onClick={() => setDeleteOpen(true)}>
                  {t("course.delete")}
                </Button>
              </div>
            </div>

            <section>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-plum-900">{t("course.detail.enrollments")}</h2>
                {eligibleMembers.length > 0 && (
                  <Button className="max-sm:min-h-11" variant="soft" icon="plus" onClick={() => setShowEnrollForm((v) => !v)}>
                    {t("enrollment.add")}
                  </Button>
                )}
              </div>
              {showEnrollForm && (
                <div className="mt-3 flex flex-col gap-3 rounded-card border border-line bg-canvas p-4">
                  <Field label={t("field.member")} htmlFor="enroll-member">
                    <Select
                      value={enrollMemberId}
                      onChange={setEnrollMemberId}
                      ariaLabel={t("field.member")}
                      className="w-full"
                      options={[{ value: NONE, label: t("field.member") }, ...eligibleMembers.map((m) => ({ value: m.id, label: m.name }))]}
                    />
                  </Field>
                  <Field label={t("field.startDate")} htmlFor="enroll-start">
                    <DatePicker id="enroll-start" value={enrollStart} onChange={setEnrollStart} />
                  </Field>
                  <div className="flex justify-end gap-2">
                    <Button className="max-sm:min-h-11" variant="ghost" onClick={() => setShowEnrollForm(false)}>
                      {t("action.cancel")}
                    </Button>
                    <Button className="max-sm:min-h-11" onClick={() => void submitEnroll()} disabled={enrollMemberId === NONE || !enrollStart}>
                      {t("action.add")}
                    </Button>
                  </div>
                </div>
              )}
              {enrollments.length === 0 ? (
                <p className="mt-2 text-sm text-muted">{t("enrollment.empty")}</p>
              ) : (
                <ul className="mt-3 flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
                  {enrollments.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink">{memberName(e.memberId)}</p>
                        <p className="text-xs text-muted">
                          {formatDate(e.startDate, locale)}
                          {e.endDate ? ` - ${formatDate(e.endDate, locale)}` : ""} - {t(`status.${e.status}` as MessageKey)}
                        </p>
                      </div>
                      <Button className="max-sm:min-h-11" variant="dangerSoft" onClick={() => setPendingEnrollment(e)}>
                        {t("enrollment.delete")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-plum-900">{t("course.detail.sessions")}</h2>
                <Button className="max-sm:min-h-11" variant="soft" icon="plus" onClick={() => setShowSessionForm((v) => !v)}>
                  {t("session.add")}
                </Button>
              </div>
              {showSessionForm && (
                <div className="mt-3 flex flex-col gap-3 rounded-card border border-line bg-canvas p-4">
                  <Field label={t("field.date")} htmlFor="session-date">
                    <DatePicker id="session-date" value={sessionDate} onChange={setSessionDate} />
                  </Field>
                  <Field label={t("field.topic")} htmlFor="session-topic">
                    <input id="session-topic" className={inputClass} value={sessionTopic} onChange={(e) => setSessionTopic(e.target.value)} />
                  </Field>
                  <div className="flex justify-end gap-2">
                    <Button className="max-sm:min-h-11" variant="ghost" onClick={() => setShowSessionForm(false)}>
                      {t("action.cancel")}
                    </Button>
                    <Button className="max-sm:min-h-11" onClick={() => void submitSession()} disabled={!sessionDate || !sessionTopic.trim()}>
                      {t("action.add")}
                    </Button>
                  </div>
                </div>
              )}
              {sessions.length === 0 ? (
                <p className="mt-2 text-sm text-muted">{t("session.empty")}</p>
              ) : (
                <ul className="mt-3 flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
                  {sessions.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink">
                          {formatDate(s.date, locale)} - {s.topic}
                        </p>
                        <p className="text-xs text-muted">
                          {t("field.trainerPresent")}: {t(s.trainerPresent ? "status.present" : "status.absent")}
                        </p>
                      </div>
                      <Button className="max-sm:min-h-11" variant="dangerSoft" onClick={() => setPendingSession(s)}>
                        {t("session.delete")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={deleteOpen}
        title={t("course.delete")}
        body={t("course.deleteBody", { name: selected?.title ?? "" })}
        confirmLabel={t("action.delete")}
        cancelLabel={t("action.cancel")}
        danger
        onConfirm={() => void confirmDeleteCourse()}
        onCancel={() => setDeleteOpen(false)}
      />
      <ConfirmDialog
        open={pendingEnrollment !== null}
        title={t("enrollment.delete")}
        body={t("enrollment.deleteBody", { name: pendingEnrollment ? memberName(pendingEnrollment.memberId) : "" })}
        confirmLabel={t("action.delete")}
        cancelLabel={t("action.cancel")}
        danger
        onConfirm={() => void confirmDeleteEnrollment()}
        onCancel={() => setPendingEnrollment(null)}
      />
      <ConfirmDialog
        open={pendingSession !== null}
        title={t("session.delete")}
        body={t("session.deleteBody")}
        confirmLabel={t("action.delete")}
        cancelLabel={t("action.cancel")}
        danger
        onConfirm={() => void confirmDeleteSession()}
        onCancel={() => setPendingSession(null)}
      />
    </div>
  );
}
