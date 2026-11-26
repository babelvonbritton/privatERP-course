"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/types";
import { getServices, today } from "@/lib/domain/services";
import type { Course, CourseStatus, CurrencyCode, Enrollment, Member, Session, Trainer } from "@/lib/domain/types";
import { allSkills, courseRequiredSkills, courseWeekdays, isDateOnSchedule, parseSessionCapacity, rankTrainersForCourse, sessionAttendees, sessionCapacity, sessionDurationHours, timeToMinutes } from "@/lib/domain/types";
import { formatMoney } from "@/lib/money";
import { fractionDigits, getCurrency, hasCurrencyPrecision, subscribeCurrency } from "@/lib/currency";
import { formatDate } from "@/lib/dates";
import { createId } from "@/lib/storage/utils";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Field, inputClass } from "../ui/Field";
import { Select } from "../ui/Select";
import { SearchField } from "../ui/SearchField";
import { DatePicker } from "../ui/DatePicker";
import { TimePicker } from "../ui/TimePicker";
import { TagInput } from "../ui/TagInput";
import { TrainerPicker } from "../ui/TrainerPicker";
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
  requiredSkills: string[];
  scheduleWeekdays: number[];
  status: CourseStatus;
}

const emptyForm = (): CourseForm => ({
  title: "",
  description: "",
  level: "",
  price: "",
  requiredSkills: [],
  scheduleWeekdays: [1],
  status: "active",
});

/** Course list with search, add and edit, a detail view for enrollments, and a Sessions section for the sessions not yet marked. */
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

  /** Sessions whose attendance has not been checked yet, across all courses, soonest first. */
  const [pendingSessions, setPendingSessions] = useState<Session[]>([]);
  /** Active enrollments per course, for the assign picker of each pending session. */
  const [pendingEnrollments, setPendingEnrollments] = useState<Map<string, Enrollment[]>>(new Map());

  const [showEnrollForm, setShowEnrollForm] = useState(false);
  const [enrollMemberId, setEnrollMemberId] = useState(NONE);
  const [enrollStart, setEnrollStart] = useState<string | null>(today());
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [pendingEnrollment, setPendingEnrollment] = useState<Enrollment | null>(null);
  /** The session awaiting delete confirmation from the Sessions section. */
  const [pendingSession, setPendingSession] = useState<Session | null>(null);

  const [assignSessionId, setAssignSessionId] = useState<string | null>(null);
  const [assignChecked, setAssignChecked] = useState<string[]>([]);

  const [standaloneOpen, setStandaloneOpen] = useState(false);
  /** The session being edited in the standalone form, or null when creating one. */
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [standaloneCourseId, setStandaloneCourseId] = useState(NONE);
  const [standaloneDate, setStandaloneDate] = useState<string | null>(today());
  const [standaloneTopic, setStandaloneTopic] = useState("");
  const [standaloneStart, setStandaloneStart] = useState("09:00");
  const [standaloneEnd, setStandaloneEnd] = useState("10:00");
  const [standaloneCapacity, setStandaloneCapacity] = useState("");
  const [standaloneTrainerId, setStandaloneTrainerId] = useState("");
  const [standaloneError, setStandaloneError] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);

  // The price label follows the current currency setting.
  const [currency, setCurrencyState] = useState<CurrencyCode>(() => getCurrency());
  useEffect(() => subscribeCurrency(() => setCurrencyState(getCurrency())), []);

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
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
      setEnrollments(await s.courses.listEnrollmentsByCourse(courseId));
    } catch (e) {
      errorCenter.report(e, { action: "course.detail" });
    }
  }, []);

  const loadPending = useCallback(async () => {
    try {
      const s = getServices();
      const found = await s.attendance.listUnmarkedSessions();
      setPendingSessions(found);
      const byCourse = new Map<string, Enrollment[]>();
      for (const courseId of [...new Set(found.map((session) => session.courseId))]) {
        byCourse.set(courseId, await s.courses.listEnrollmentsByCourse(courseId));
      }
      setPendingEnrollments(byCourse);
    } catch (e) {
      errorCenter.report(e, { action: "session.pending" });
    }
  }, []);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  useEffect(() => {
    const handle = setTimeout(() => {
      void load(query);
    }, 180);
    return () => clearTimeout(handle);
  }, [query, load]);

  const standaloneCourse = useMemo(() => courses.find((c) => c.id === standaloneCourseId) ?? null, [courses, standaloneCourseId]);
  /** Trainers qualified for a standalone session, ranked by matching required skills. */
  const rankedStandaloneTrainers = useMemo(
    () => (standaloneCourse ? rankTrainersForCourse(trainers, courseRequiredSkills(standaloneCourse)) : []),
    [standaloneCourse, trainers],
  );

  const openStandalone = () => {
    setEditingSession(null);
    setStandaloneCourseId(NONE);
    setStandaloneDate(today());
    setStandaloneTopic("");
    setStandaloneStart("09:00");
    setStandaloneEnd("10:00");
    setStandaloneCapacity("");
    setStandaloneTrainerId("");
    setStandaloneError(null);
    setStandaloneOpen(true);
  };

  /** Opens the same session form pre-filled, to edit a session from the Sessions section. The course is fixed: a session never moves courses. */
  const openEditSession = (session: Session) => {
    setEditingSession(session);
    setStandaloneCourseId(session.courseId);
    setStandaloneDate(session.date);
    setStandaloneTopic(session.topic);
    setStandaloneStart(session.startTime);
    setStandaloneEnd(session.endTime);
    setStandaloneCapacity(session.capacity === null ? "" : String(session.capacity));
    setStandaloneTrainerId(session.trainerId);
    setStandaloneError(null);
    setStandaloneOpen(true);
  };

  const submitStandaloneSession = async () => {
    if (!standaloneCourse || !standaloneDate || !standaloneTopic.trim()) return;
    const dayError = scheduledDayError(standaloneDate, standaloneCourse, "field.date");
    if (dayError) {
      setStandaloneError(dayError);
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(standaloneStart) || !/^\d{2}:\d{2}$/.test(standaloneEnd)) {
      setStandaloneError(t("validation.time", { field: t("field.startTime") }));
      return;
    }
    const startMinutes = timeToMinutes(standaloneStart);
    const endMinutes = timeToMinutes(standaloneEnd);
    if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
      setStandaloneError(t("validation.endAfterStart"));
      return;
    }
    if (rankedStandaloneTrainers.length === 0) {
      setStandaloneError(t("session.noQualifiedTrainer"));
      return;
    }
    if (!standaloneTrainerId) {
      setStandaloneError(t("validation.required", { field: t("field.trainer") }));
      return;
    }
    const capacity = parseSessionCapacity(standaloneCapacity);
    if (capacity === undefined) {
      setStandaloneError(t("validation.positive", { field: t("field.capacity") }));
      return;
    }
    try {
      if (editingSession) {
        await getServices().attendance.updateSession(editingSession.id, {
          date: standaloneDate,
          topic: standaloneTopic.trim(),
          trainerId: standaloneTrainerId,
          startTime: standaloneStart,
          endTime: standaloneEnd,
          capacity,
          idempotencyKey: createId(),
        });
      } else {
        await getServices().attendance.createSession({
          courseId: standaloneCourse.id,
          date: standaloneDate,
          topic: standaloneTopic.trim(),
          trainerId: standaloneTrainerId,
          trainerPresent: false,
          startTime: standaloneStart,
          endTime: standaloneEnd,
          capacity,
          idempotencyKey: createId(),
        });
      }
      errorCenter.notify({ key: "toast.saved" });
      setStandaloneOpen(false);
      setEditingSession(null);
      setStandaloneTopic("");
      setStandaloneDate(today());
      setStandaloneCapacity("");
      setStandaloneTrainerId("");
      setStandaloneError(null);
      await load(query);
      await loadPending();
      if (selected?.id === standaloneCourse.id) await loadDetail(selected.id);
    } catch (e) {
      errorCenter.report(e, { action: editingSession ? "session.update" : "session.create" });
    }
  };

  const openDetail = (course: Course) => {
    setSelected(course);
    setShowEnrollForm(false);
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
      requiredSkills: courseRequiredSkills(course),
      scheduleWeekdays: courseWeekdays(course),
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
    const price = Number(form.price);
    if (!hasCurrencyPrecision(price, currency) || price < 0) {
      setFormError(t("validation.invalid", { field: t("field.price", { currency }) }));
      return;
    }
    if (form.scheduleWeekdays.length === 0) {
      setFormError(t("validation.required", { field: t("field.scheduleWeekdays") }));
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
          requiredSkills: form.requiredSkills,
          scheduleWeekdays: form.scheduleWeekdays,
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
          requiredSkills: form.requiredSkills,
          scheduleWeekdays: form.scheduleWeekdays,
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
    const label = selected.title;
    try {
      await getServices().courses.remove(selected.id);
      errorCenter.notify({ key: "trash.movedToTrash", vars: { label } });
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

  /** Members actively enrolled in one course, for that course's session assign picker. */
  const enrolledForCourse = useCallback(
    (courseId: string) => {
      const byId = new Map(members.map((m) => [m.id, m]));
      return (pendingEnrollments.get(courseId) ?? [])
        .filter((e) => e.status === "active")
        .map((e) => byId.get(e.memberId))
        .filter((m): m is Member => m !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    [pendingEnrollments, members],
  );

  const openAssign = (session: Session) => {
    if (assignSessionId === session.id) {
      setAssignSessionId(null);
      return;
    }
    setAssignChecked(sessionAttendees(session) ?? []);
    setAssignSessionId(session.id);
  };

  const saveAssign = async (session: Session) => {
    try {
      await getServices().attendance.assignSessionAttendees(session.id, assignChecked, createId());
      errorCenter.notify({ key: "toast.saved" });
      setAssignSessionId(null);
      setAssignChecked([]);
      await loadPending();
      if (selected) await loadDetail(selected.id);
    } catch (e) {
      errorCenter.report(e, { action: "session.assign" });
    }
  };

  /** Names the allowed weekdays when a date falls outside the course's weekly slot, or null when the date is fine. */
  const scheduledDayError = (date: string | null, course: Course, fieldKey: MessageKey): string | null => {
    if (!date) return null;
    const days = courseWeekdays(course);
    if (isDateOnSchedule(date, days)) return null;
    return t("validation.notScheduledDay", { field: t(fieldKey), days: days.map((d) => t(`weekday.${d}` as MessageKey)).join(", ") });
  };

  const submitEnroll = async () => {
    if (!selected || enrollMemberId === NONE || !enrollStart) return;
    const dayError = scheduledDayError(enrollStart, selected, "field.startDate");
    if (dayError) {
      setEnrollError(dayError);
      return;
    }
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
      setEnrollError(null);
      setEnrollMemberId(NONE);
      setEnrollStart(today());
      await loadDetail(selected.id);
    } catch (e) {
      errorCenter.report(e, { action: "enrollment.create" });
    }
  };

  const confirmDeleteEnrollment = async () => {
    if (!selected || !pendingEnrollment) return;
    const label = memberName(pendingEnrollment.memberId);
    try {
      await getServices().courses.removeEnrollment(pendingEnrollment.id);
      errorCenter.notify({ key: "trash.movedToTrash", vars: { label } });
      setPendingEnrollment(null);
      await loadDetail(selected.id);
    } catch (e) {
      errorCenter.report(e, { action: "enrollment.delete" });
    }
  };

  /** Deletes the session awaiting confirmation from the Sessions section. */
  const confirmDeleteSession = async () => {
    if (!pendingSession) return;
    const label = pendingSession.topic;
    try {
      await getServices().attendance.removeSession(pendingSession.id);
      errorCenter.notify({ key: "trash.movedToTrash", vars: { label } });
      setPendingSession(null);
      await loadPending();
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
        <div className="flex gap-2">
          <Button className="max-sm:min-h-11" variant="soft" icon="plus" onClick={openStandalone}>
            {t("session.add")}
          </Button>
          <Button className="max-sm:min-h-11" icon="plus" onClick={openAdd}>
            {t("course.add")}
          </Button>
        </div>
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
                <th scope="col" className="px-4 py-3 font-medium">{t("field.requiredSkills")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.level")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("field.price", { currency })}</th>
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
                  <td className="max-w-[12rem] truncate px-4 py-3 text-ink">{courseRequiredSkills(course).join(", ")}</td>
                  <td className="px-4 py-3 text-ink">{course.level}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-ink">{formatMoney(course.price, locale)}</td>
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

      {/* Always rendered, even with no courses yet: the tour points at this
          section, and its empty text says what will appear here. */}
      <section data-tour="course-sessions" aria-labelledby="pending-sessions-heading" className="flex flex-col gap-3">
          <h2 id="pending-sessions-heading" className="text-base font-semibold text-plum-900">{t("session.pending")}</h2>
          {pendingSessions.length === 0 ? (
            <p className="text-sm text-muted">{t("session.pendingEmpty")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
              {pendingSessions.map((s) => {
                const course = courses.find((c) => c.id === s.courseId);
                const hours = sessionDurationHours(s);
                const assigned = sessionAttendees(s);
                const assignedNames = (assigned ?? []).map((id) => memberName(id)).filter((n) => n !== "");
                const enrolled = enrolledForCourse(s.courseId);
                const assignOpen = assignSessionId === s.id;
                const cap = sessionCapacity(s);
                // Once the selection reaches the session's cap, members not
                // yet selected cannot be added; checked members can still be
                // removed, and the service re-checks the cap on save.
                const atCap = cap !== null && assignChecked.length >= cap;
                return (
                  <li key={s.id} className="flex flex-col gap-2 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink">
                          {formatDate(s.date, locale)}
                          {s.startTime && s.endTime ? ` ${s.startTime}–${s.endTime}` : ""} - {s.topic}
                        </p>
                        <p className="text-xs text-muted">
                          {hours !== null ? `${t("duration.hours", { hours })} · ` : ""}
                          {t("field.trainerPresent")}: {t(s.trainerPresent ? "status.present" : "status.absent")}
                        </p>
                        <p className="text-xs text-muted">
                          {assigned === null
                            ? t("session.notAssigned")
                            : assignedNames.length > 0
                              ? t("session.assigned", { names: assignedNames.join(", ") })
                              : t("session.assignedCount", { count: assigned.length })}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {course && (
                          <span className="inline-block rounded-full bg-plum-100 px-2.5 py-1 text-xs font-medium text-plum-900">{course.title}</span>
                        )}
                        {enrolled.length > 0 && (
                          <Button
                            className="max-sm:min-h-11"
                            variant="soft"
                            aria-expanded={assignOpen}
                            aria-controls={`assign-${s.id}`}
                            onClick={() => openAssign(s)}
                          >
                            {t("session.assign")}
                          </Button>
                        )}
                        <Button
                          className="max-sm:min-h-11"
                          variant="soft"
                          icon="pencil"
                          onClick={() => openEditSession(s)}
                        >
                          {t("session.edit")}
                        </Button>
                        <Button
                          className="max-sm:min-h-11"
                          variant="dangerSoft"
                          icon="trash"
                          onClick={() => setPendingSession(s)}
                        >
                          {t("session.delete")}
                        </Button>
                      </div>
                    </div>
                    {assignOpen && (
                      <fieldset id={`assign-${s.id}`} className="rounded-card border border-line bg-canvas p-3">
                        <legend className="px-1 text-sm font-medium text-ink">{t("session.assignTitle")}</legend>
                        <p className="text-xs text-muted">{t("session.assignHint")}</p>
                        {atCap && cap !== null && (
                          <p role="status" className="mt-1 text-xs text-muted">{t("session.assignAtCapacity", { capacity: cap })}</p>
                        )}
                        <div className="mt-2 flex">
                          <Button
                            variant="ghost"
                            className="max-sm:min-h-11"
                            onClick={() => setAssignChecked(enrolled.slice(0, cap ?? enrolled.length).map((m) => m.id))}
                          >
                            {t("session.selectAll")}
                          </Button>
                        </div>
                        <div className="mt-1 flex flex-col">
                          {enrolled.map((m) => {
                            const checked = assignChecked.includes(m.id);
                            const rowDisabled = atCap && !checked;
                            return (
                              <label key={m.id} className={`flex min-h-11 items-center gap-2.5 text-sm text-ink ${rowDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={rowDisabled}
                                  onChange={() => setAssignChecked((prev) => (checked ? prev.filter((id) => id !== m.id) : [...prev, m.id]))}
                                  className="size-4 shrink-0 accent-plum-600"
                                />
                                {m.name}
                              </label>
                            );
                          })}
                        </div>
                        <div className="mt-2 flex justify-end gap-2">
                          <Button className="max-sm:min-h-11" variant="ghost" onClick={() => setAssignSessionId(null)}>
                            {t("action.cancel")}
                          </Button>
                          <Button className="max-sm:min-h-11" onClick={() => void saveAssign(s)}>
                            {t("action.save")}
                          </Button>
                        </div>
                      </fieldset>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

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
          <Field label={t("field.price", { currency })} htmlFor="course-price" hint={t("hint.coursePrice")}>
            <input id="course-price" type="number" min={0} step={fractionDigits(currency) === 0 ? 1 : 0.01} inputMode={fractionDigits(currency) === 0 ? "numeric" : "decimal"} className={inputClass} value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} />
          </Field>
          <Field label={t("field.requiredSkills")} htmlFor="course-required-skills" hint={t("hint.courseRequiredSkills")}>
            <TagInput
              id="course-required-skills"
              value={form.requiredSkills}
              onChange={(requiredSkills) => setForm((f) => ({ ...f, requiredSkills }))}
              suggestions={allSkills(trainers, courses)}
              placeholder={t("tagInput.placeholder")}
            />
          </Field>
          <Field label={t("field.scheduleWeekdays")} htmlFor="course-weekday-1" hint={t("hint.courseSchedule")}>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t("field.scheduleWeekdays")}>
              {[0, 1, 2, 3, 4, 5, 6].map((n) => {
                const checked = form.scheduleWeekdays.includes(n);
                return (
                  <label
                    key={n}
                    className={`flex cursor-pointer items-center gap-2 rounded-control border px-3 py-2 text-sm transition-colors duration-200 max-sm:min-h-11 ${checked ? "border-plum-600 bg-plum-50 font-medium text-plum-900" : "border-line bg-surface text-ink hover:border-plum-200"}`}
                  >
                    <input
                      id={`course-weekday-${n}`}
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setForm((f) => ({
                          ...f,
                          scheduleWeekdays: checked ? f.scheduleWeekdays.filter((d) => d !== n) : [...f.scheduleWeekdays, n].sort((a, b) => a - b),
                        }))
                      }
                      className="size-4 shrink-0 accent-plum-600"
                    />
                    {t(`weekday.short.${n}` as MessageKey)}
                  </label>
                );
              })}
            </div>
          </Field>
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

      <Modal open={standaloneOpen} onOpenChange={setStandaloneOpen} title={editingSession ? t("session.edit") : t("session.add")}>
        <div className="flex flex-col gap-4">
          {editingSession ? (
            <Field label={t("field.course")}>
              <p className="text-sm text-ink">{standaloneCourse?.title ?? ""}</p>
            </Field>
          ) : (
            <Field label={t("field.course")} htmlFor="standalone-course">
              <Select
                value={standaloneCourseId}
                onChange={(v) => {
                  setStandaloneCourseId(v);
                  setStandaloneTrainerId("");
                  setStandaloneError(null);
                }}
                ariaLabel={t("field.course")}
                className="w-full"
                options={[
                  { value: NONE, label: t("field.course") },
                  ...courses
                    .filter((c) => c.status === "active")
                    .map((c) => ({ value: c.id, label: c.title })),
                ]}
              />
            </Field>
          )}
          {standaloneCourse && (
            <p className="text-sm text-muted">
              {t("field.requiredSkills")}:{" "}
              {courseRequiredSkills(standaloneCourse).length > 0 ? courseRequiredSkills(standaloneCourse).join(", ") : t("session.noRequiredSkills")}
            </p>
          )}
          <Field label={t("field.date")} htmlFor="standalone-date">
            <DatePicker id="standalone-date" value={standaloneDate} onChange={setStandaloneDate} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("field.startTime")} htmlFor="standalone-start">
              <TimePicker id="standalone-start" ariaLabel={t("field.startTime")} value={standaloneStart} onChange={setStandaloneStart} />
            </Field>
            <Field label={t("field.endTime")} htmlFor="standalone-end">
              <TimePicker id="standalone-end" ariaLabel={t("field.endTime")} value={standaloneEnd} onChange={setStandaloneEnd} />
            </Field>
          </div>
          <Field label={t("field.topic")} htmlFor="standalone-topic">
            <input id="standalone-topic" className={inputClass} value={standaloneTopic} onChange={(e) => setStandaloneTopic(e.target.value)} />
          </Field>
          <Field label={t("field.capacity")} htmlFor="standalone-capacity" hint={t("hint.sessionCapacity")}>
            <input id="standalone-capacity" type="number" min={1} step={1} inputMode="numeric" className={inputClass} value={standaloneCapacity} onChange={(e) => setStandaloneCapacity(e.target.value)} />
          </Field>
          <Field label={t("field.trainer")}>
            <TrainerPicker
              name="standalone-trainer"
              trainers={rankedStandaloneTrainers}
              requiredSkills={standaloneCourse ? courseRequiredSkills(standaloneCourse) : []}
              value={standaloneTrainerId}
              onChange={setStandaloneTrainerId}
              label={t("field.trainer")}
              disabled={!standaloneCourse}
              disabledHint={t("session.chooseCourseFirst")}
              emptyMessage={t("session.noQualifiedTrainer")}
            />
          </Field>
          {standaloneError && (
            <p role="alert" className="text-sm text-danger">
              {standaloneError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button className="max-sm:min-h-11" variant="ghost" onClick={() => setStandaloneOpen(false)}>
              {t("action.cancel")}
            </Button>
            <Button
              className="max-sm:min-h-11"
              onClick={() => void submitStandaloneSession()}
              disabled={!standaloneCourse || !standaloneDate || !standaloneTopic.trim() || !/^\d{2}:\d{2}$/.test(standaloneStart) || !/^\d{2}:\d{2}$/.test(standaloneEnd) || rankedStandaloneTrainers.length === 0}
            >
              {editingSession ? t("action.save") : t("action.add")}
            </Button>
          </div>
        </div>
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
                {courseWeekdays(selected).map((d) => t(`weekday.short.${d}` as MessageKey)).join(", ")} - {formatMoney(selected.price, locale)}
                {courseRequiredSkills(selected).length > 0 ? ` - ${courseRequiredSkills(selected).join(", ")}` : ""}
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
                  <Button className="max-sm:min-h-11" variant="soft" icon="plus" onClick={() => { setEnrollError(null); setShowEnrollForm((v) => !v); }}>
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
                  {enrollError && (
                    <p role="alert" className="text-sm text-danger">
                      {enrollError}
                    </p>
                  )}
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
                <ul className="mt-3 flex max-h-80 flex-col divide-y divide-line overflow-y-auto rounded-card border border-line bg-surface">
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
