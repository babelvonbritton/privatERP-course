"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/types";
import { getServices, today, type AttendanceDashboardSummary, type TrainerDashboardSummary } from "@/lib/domain/services";
import type { AttendanceStatus, Course, Enrollment, Member, Session, Trainer } from "@/lib/domain/types";
import { courseRequiredSkills, courseWeekdays, isAttendingStatus, isDateOnSchedule, parseSessionCapacity, rankTrainersForCourse, sessionCapacity, sessionDurationHours, timeToMinutes } from "@/lib/domain/types";
import { formatDate } from "@/lib/dates";
import { createId } from "@/lib/storage/utils";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Field, inputClass } from "../ui/Field";
import { Select } from "../ui/Select";
import { DatePicker } from "../ui/DatePicker";
import { TimePicker } from "../ui/TimePicker";
import { TrainerPicker } from "../ui/TrainerPicker";
import { Switch } from "../ui/Switch";
import { Icon } from "../ui/Icon";
import { GuideDialog } from "../GuideDialog";
import type { NavId } from "../nav";

/** Placeholder value for selects with nothing chosen yet. */
const NONE = "__none__";

/** "All" value for the dashboard filters. */
const ALL = "all";
/** Dashboard rows per page. */
const PAGE_SIZE = 10;

const MARK_STATUSES: AttendanceStatus[] = ["present", "absent", "late"];

/** Pick a course and session, then mark each enrolled member present, absent, or late. */
export function AttendanceScreen({ navigate: _navigate }: { navigate: (id: NavId) => void }) {
  const { t, locale } = useI18n();
  const [courses, setCourses] = useState<Course[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [courseId, setCourseId] = useState(NONE);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState(NONE);
  const [session, setSession] = useState<Session | null>(null);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [marks, setMarks] = useState<Record<string, AttendanceStatus>>({});
  const [trainerPresent, setTrainerPresent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newDate, setNewDate] = useState<string | null>(today());
  const [newTopic, setNewTopic] = useState("");
  const [newStartTime, setNewStartTime] = useState("09:00");
  const [newEndTime, setNewEndTime] = useState("10:00");
  const [newCapacity, setNewCapacity] = useState("");
  const [newTrainerId, setNewTrainerId] = useState("");
  const [newSessionError, setNewSessionError] = useState<string | null>(null);

  const [summary, setSummary] = useState<AttendanceDashboardSummary | null>(null);
  const [trainerSummary, setTrainerSummary] = useState<TrainerDashboardSummary | null>(null);
  const [dashboardTab, setDashboardTab] = useState<"members" | "trainers">("members");
  const [filterTrainer, setFilterTrainer] = useState(ALL);
  const [filterMember, setFilterMember] = useState(ALL);
  const [filterCourse, setFilterCourse] = useState(ALL);
  const [dashboardPage, setDashboardPage] = useState(1);

  /** Time range and duration for a session, empty when the session predates time ranges. */
  const timeLabel = (s: Session): string => {
    if (!s.startTime || !s.endTime) return "";
    const hours = sessionDurationHours(s);
    return hours === null ? ` ${s.startTime}–${s.endTime}` : ` ${s.startTime}–${s.endTime} (${t("duration.hours", { hours })})`;
  };

  /** Pending attending count against the open session's cap, for the marking UI. */
  const markingCap = session ? sessionCapacity(session) : null;
  const attendingCount = useMemo(() => Object.values(marks).filter(isAttendingStatus).length, [marks]);
  const capReached = markingCap !== null && attendingCount >= markingCap;

  const loadDashboard = useCallback(
    async (trainerId: string, memberId: string, courseIdValue: string) => {
      try {
        const s = getServices();
        const [memberData, trainerData] = await Promise.all([
          s.attendance.dashboardSummary({
            trainerId: trainerId === ALL ? undefined : trainerId,
            memberId: memberId === ALL ? undefined : memberId,
            courseId: courseIdValue === ALL ? undefined : courseIdValue,
          }),
          s.attendance.trainerDashboardSummary({
            trainerId: trainerId === ALL ? undefined : trainerId,
            courseId: courseIdValue === ALL ? undefined : courseIdValue,
          }),
        ]);
        setSummary(memberData);
        setTrainerSummary(trainerData);
      } catch (e) {
        errorCenter.report(e, { action: "attendance.dashboard" });
      }
    },
    [],
  );

  const applyDashboardFilter = (which: "trainer" | "member" | "course", value: string) => {
    const next = {
      trainer: which === "trainer" ? value : filterTrainer,
      member: which === "member" ? value : filterMember,
      course: which === "course" ? value : filterCourse,
    };
    if (which === "trainer") setFilterTrainer(value);
    if (which === "member") setFilterMember(value);
    if (which === "course") setFilterCourse(value);
    setDashboardPage(1);
    void loadDashboard(next.trainer, next.member, next.course);
  };

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const memberName = (id: string) => memberById.get(id)?.name ?? "";
  const selectedCourse = useMemo(() => courses.find((c) => c.id === courseId) ?? null, [courses, courseId]);
  /** Trainers qualified for a session of the chosen course, ranked by matching required skills. */
  const rankedNewSessionTrainers = useMemo(
    () => (selectedCourse ? rankTrainersForCourse(trainers, courseRequiredSkills(selectedCourse)) : []),
    [selectedCourse, trainers],
  );

  useEffect(() => {
    const load = async () => {
      try {
        const s = getServices();
        const [allCourses, memberList, trainerList] = await Promise.all([s.courses.list(), s.members.list(), s.trainers.list()]);
        setCourses(allCourses.filter((c) => c.status === "active"));
        setMembers(memberList);
        setTrainers(trainerList);
      } catch (e) {
        errorCenter.report(e, { action: "attendance.list" });
      }
    };
    void load();
    void loadDashboard(ALL, ALL, ALL);
  }, [loadDashboard]);

  const chooseCourse = async (id: string) => {
    setCourseId(id);
    setSessionId(NONE);
    setSession(null);
    setEnrollments([]);
    setMarks({});
    setNewTrainerId("");
    if (id === NONE) {
      setSessions([]);
      return;
    }
    try {
      const found = await getServices().attendance.listSessionsByCourse(id);
      setSessions([...found].sort((a, b) => b.date.localeCompare(a.date) || (b.startTime || "").localeCompare(a.startTime || "") || b.topic.localeCompare(a.topic)));
    } catch (e) {
      errorCenter.report(e, { action: "attendance.sessions" });
    }
  };

  const chooseSession = async (id: string) => {
    setSessionId(id);
    if (id === NONE) {
      setSession(null);
      setEnrollments([]);
      setMarks({});
      return;
    }
    try {
      const s = getServices();
      const [found, allEnrollments, rows] = await Promise.all([
        s.attendance.getSession(id),
        s.courses.listEnrollmentsByCourse(courseId),
        s.attendance.listAttendance(id),
      ]);
      const active = allEnrollments.filter((e) => e.status === "active");
      setSession(found ?? null);
      setTrainerPresent(found?.trainerPresent ?? false);
      setEnrollments(active);
      const saved = new Map(rows.map((r) => [r.memberId, r.status]));
      const next: Record<string, AttendanceStatus> = {};
      // Unmarked members default to present, but only up to the session cap:
      // the rest start absent, so the form never opens already over the cap.
      const cap = found ? sessionCapacity(found) : null;
      let attending = 0;
      for (const e of active) {
        const savedMark = saved.get(e.memberId);
        if (savedMark) {
          next[e.memberId] = savedMark;
          if (isAttendingStatus(savedMark)) attending++;
        } else if (cap === null || attending < cap) {
          next[e.memberId] = "present";
          attending++;
        } else {
          next[e.memberId] = "absent";
        }
      }
      setMarks(next);
    } catch (e) {
      errorCenter.report(e, { action: "attendance.load" });
    }
  };

  const toggleTrainer = async (present: boolean) => {
    if (!session) return;
    try {
      await getServices().attendance.setTrainerPresent(session.id, present, createId());
      setTrainerPresent(present);
      setSession({ ...session, trainerPresent: present });
    } catch (e) {
      errorCenter.report(e, { action: "attendance.trainerPresent" });
    }
  };

  const saveMarks = async () => {
    if (!session) return;
    setSaving(true);
    try {
      const marksList = enrollments.map((e) => ({ memberId: e.memberId, status: marks[e.memberId] ?? "present" }));
      await getServices().attendance.mark(session.id, marksList, createId());
      errorCenter.notify({ key: "attendance.saved" });
      void loadDashboard(filterTrainer, filterMember, filterCourse);
    } catch (e) {
      errorCenter.report(e, { action: "attendance.mark" });
    } finally {
      setSaving(false);
    }
  };

  const createNewSession = async () => {
    if (!selectedCourse || !newDate || !newTopic.trim()) return;
    const days = courseWeekdays(selectedCourse);
    if (!isDateOnSchedule(newDate, days)) {
      setNewSessionError(t("validation.notScheduledDay", { field: t("field.date"), days: days.map((d) => t(`weekday.${d}` as MessageKey)).join(", ") }));
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(newStartTime) || !/^\d{2}:\d{2}$/.test(newEndTime)) {
      setNewSessionError(t("validation.time", { field: t("field.startTime") }));
      return;
    }
    const startMinutes = timeToMinutes(newStartTime);
    const endMinutes = timeToMinutes(newEndTime);
    if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
      setNewSessionError(t("validation.endAfterStart"));
      return;
    }
    if (rankedNewSessionTrainers.length === 0) {
      setNewSessionError(t("session.noQualifiedTrainer"));
      return;
    }
    if (!newTrainerId) {
      setNewSessionError(t("validation.required", { field: t("field.trainer") }));
      return;
    }
    const capacity = parseSessionCapacity(newCapacity);
    if (capacity === undefined) {
      setNewSessionError(t("validation.positive", { field: t("field.capacity") }));
      return;
    }
    try {
      const created = await getServices().attendance.createSession({
        courseId: selectedCourse.id,
        date: newDate,
        topic: newTopic.trim(),
        trainerId: newTrainerId,
        trainerPresent: false,
        startTime: newStartTime,
        endTime: newEndTime,
        capacity,
        idempotencyKey: createId(),
      });
      errorCenter.notify({ key: "toast.saved" });
      setNewSessionOpen(false);
      setNewTopic("");
      setNewDate(today());
      setNewCapacity("");
      setNewTrainerId("");
      setNewSessionError(null);
      const found = await getServices().attendance.listSessionsByCourse(selectedCourse.id);
      setSessions([...found].sort((a, b) => b.date.localeCompare(a.date) || (b.startTime || "").localeCompare(a.startTime || "") || b.topic.localeCompare(a.topic)));
      await chooseSession(created.id);
      void loadDashboard(filterTrainer, filterMember, filterCourse);
    } catch (e) {
      errorCenter.report(e, { action: "session.create" });
    }
  };

  const switchDashboardTab = (tab: "members" | "trainers") => {
    setDashboardTab(tab);
    setDashboardPage(1);
  };

  const memberPageCount = Math.max(1, Math.ceil((summary?.rows.length ?? 0) / PAGE_SIZE));
  const trainerPageCount = Math.max(1, Math.ceil((trainerSummary?.rows.length ?? 0) / PAGE_SIZE));
  const pageCount = dashboardTab === "trainers" ? trainerPageCount : memberPageCount;
  const currentPage = Math.min(dashboardPage, pageCount);
  const memberPageRows = (summary?.rows ?? []).slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const trainerPageRows = (trainerSummary?.rows ?? []).slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div data-tour="attendance" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-1">
          <h1 className="text-2xl font-semibold text-plum-900">{t("attendance.title")}</h1>
          <button
            type="button"
            onClick={() => setGuideOpen(true)}
            aria-label={t("guide.open")}
            className="grid size-8 max-sm:size-11 shrink-0 place-items-center rounded-full text-muted transition-colors duration-200 hover:bg-plum-100 hover:text-ink"
          >
            <Icon name="help" size={18} />
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4 md:flex-row md:items-end">
        <div className="min-w-0 flex-1">
          <Field label={t("field.course")} htmlFor="attendance-course">
            <Select
              value={courseId}
              onChange={(v) => void chooseCourse(v)}
              ariaLabel={t("field.course")}
              className="w-full"
              options={[{ value: NONE, label: t("attendance.pickCourse") }, ...courses.map((c) => ({ value: c.id, label: c.title }))]}
            />
          </Field>
        </div>
        <div className="min-w-0 flex-1">
          <Field label={t("session.title")} htmlFor="attendance-session">
            <Select
              value={sessionId}
              onChange={(v) => void chooseSession(v)}
              ariaLabel={t("session.title")}
              className="w-full"
              options={[
                { value: NONE, label: t("attendance.pickSession") },
                ...sessions.map((s) => ({ value: s.id, label: `${formatDate(s.date, locale)}${timeLabel(s)} - ${s.topic}` })),
              ]}
            />
          </Field>
        </div>
        <Button
          variant="soft"
          icon="plus"
          disabled={courseId === NONE}
          onClick={() => {
            if (selectedCourse) {
              setNewStartTime("09:00");
              setNewEndTime("10:00");
              setNewCapacity("");
              setNewTrainerId("");
              setNewSessionError(null);
            }
            setNewSessionOpen(true);
          }}
          className="shrink-0 max-sm:min-h-11"
        >
          {t("attendance.newSession")}
        </Button>
      </div>

      {!session ? (
        <div className="rounded-card border border-line bg-surface px-6 py-12 text-center">
          <p className="text-base font-medium text-ink">{t("attendance.empty")}</p>
          <p className="mt-1 text-sm text-muted">{t("attendance.emptyHint")}</p>
        </div>
      ) : enrollments.length === 0 ? (
        <div className="rounded-card border border-line bg-surface px-6 py-12 text-center">
          <p className="text-base font-medium text-ink">{t("attendance.noEnrollments")}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <div className="border-b border-line px-4 py-3">
            <p className="text-sm font-semibold text-plum-900">
              {formatDate(session.date, locale)}
              {timeLabel(session)} - {session.topic}
            </p>
            <p className="text-xs text-muted">{selectedCourse?.title ?? ""}</p>
            {markingCap !== null && (
              <p role="status" className="mt-1 text-xs text-muted">
                {capReached
                  ? t("validation.sessionFull", { attending: attendingCount, capacity: markingCap })
                  : t("session.attendingCount", { attending: attendingCount, capacity: markingCap })}
              </p>
            )}
          </div>
          <div className="border-b border-line px-4 py-2">
            <Switch checked={trainerPresent} onChange={(v) => void toggleTrainer(v)} label={t("attendance.trainerPresent")} />
          </div>
          <ul className="flex flex-col divide-y divide-line">
            {enrollments.map((e) => (
              <li key={e.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-sm font-medium text-ink">{memberName(e.memberId)}</span>
                <div role="radiogroup" aria-label={memberName(e.memberId)} className="flex w-fit overflow-hidden rounded-control border border-line">
                  {MARK_STATUSES.map((status) => (
                    <button
                      key={status}
                      type="button"
                      role="radio"
                      aria-checked={marks[e.memberId] === status}
                      // At the cap, present/late are unavailable for members
                      // not already attending; absent stays open so a place
                      // can be freed, and the reason is shown above the list.
                      disabled={capReached && isAttendingStatus(status) && marks[e.memberId] !== status}
                      onClick={() => setMarks((prev) => ({ ...prev, [e.memberId]: status }))}
                      className={`px-3 py-2 text-sm transition-colors duration-200 max-sm:min-h-11 max-sm:px-4 disabled:cursor-not-allowed disabled:opacity-50 ${
                        marks[e.memberId] === status ? "bg-plum-600 text-white" : "bg-surface text-ink hover:bg-plum-50"
                      }`}
                    >
                      {t(`status.${status}`)}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <div className="flex justify-end border-t border-line px-4 py-3">
            <Button className="max-sm:min-h-11" onClick={() => void saveMarks()} disabled={saving}>
              {t("attendance.mark")}
            </Button>
          </div>
        </div>
      )}

      <section aria-label={t("attendance.dashboard")} className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
        <h2 className="text-base font-semibold text-plum-900">{t("attendance.dashboard")}</h2>
        <div role="tablist" aria-label={t("attendance.dashboard")} className="relative flex w-fit rounded-control bg-plum-100 p-1">
          <button
            type="button"
            role="tab"
            aria-selected={dashboardTab === "members"}
            onClick={() => switchDashboardTab("members")}
            className={`relative flex h-8 items-center rounded-[8px] px-3 text-sm transition-colors duration-200 max-sm:min-h-11 ${dashboardTab === "members" ? "font-medium text-plum-900" : "text-muted hover:text-ink"}`}
          >
            {t("attendance.tabMembers")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={dashboardTab === "trainers"}
            onClick={() => switchDashboardTab("trainers")}
            className={`relative flex h-8 items-center rounded-[8px] px-3 text-sm transition-colors duration-200 max-sm:min-h-11 ${dashboardTab === "trainers" ? "font-medium text-plum-900" : "text-muted hover:text-ink"}`}
          >
            {t("attendance.tabTrainers")}
          </button>
        </div>
        <div className="flex flex-col gap-3 md:flex-row">
          <div className="min-w-0 flex-1">
            <Field label={t("field.trainer")} htmlFor="dashboard-trainer">
              <Select
                value={filterTrainer}
                onChange={(v) => applyDashboardFilter("trainer", v)}
                ariaLabel={t("field.trainer")}
                className="w-full"
                options={[{ value: ALL, label: t("attendance.all") }, ...trainers.map((tr) => ({ value: tr.id, label: tr.name }))]}
              />
            </Field>
          </div>
          {dashboardTab === "members" && (
            <div className="min-w-0 flex-1">
              <Field label={t("field.member")} htmlFor="dashboard-member">
                <Select
                  value={filterMember}
                  onChange={(v) => applyDashboardFilter("member", v)}
                  ariaLabel={t("field.member")}
                  className="w-full"
                  options={[{ value: ALL, label: t("attendance.all") }, ...members.map((m) => ({ value: m.id, label: m.name }))]}
                />
              </Field>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <Field label={t("field.course")} htmlFor="dashboard-course">
              <Select
                value={filterCourse}
                onChange={(v) => applyDashboardFilter("course", v)}
                ariaLabel={t("field.course")}
                className="w-full"
                options={[{ value: ALL, label: t("attendance.all") }, ...courses.map((c) => ({ value: c.id, label: c.title }))]}
              />
            </Field>
          </div>
        </div>
        {dashboardTab === "members" && summary && (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <p>
                <span className="font-semibold text-ink">{summary.totalSessions}</span> <span className="text-muted">{t("session.title")}</span>
              </p>
              <p>
                <span className="font-semibold text-ink">{summary.overallRate}%</span> <span className="text-muted">{t("dashboard.attendanceRate")}</span>
              </p>
              <p>
                <span className="font-semibold text-ink">{t("duration.hours", { hours: summary.totalAttendedHours })}</span>{" "}
                <span className="text-muted">{t("field.duration")}</span>
              </p>
            </div>
            {summary.rows.length === 0 ? (
              <p className="text-sm text-muted">{t("attendance.noData")}</p>
            ) : (
              <>
                <div role="region" tabIndex={0} aria-label={t("attendance.dashboard")} className="relative overflow-x-auto rounded-card border border-line bg-surface">
                  <table className="w-full min-w-[44rem] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-muted">
                        <th scope="col" className="px-4 py-3 font-medium">{t("field.member")}</th>
                        <th scope="col" className="px-4 py-3 font-medium">{t("field.course")}</th>
                        <th scope="col" className="px-4 py-3 font-medium">{t("session.title")}</th>
                        <th scope="col" className="px-4 py-3 font-medium">{t("status.present")}</th>
                        <th scope="col" className="px-4 py-3 font-medium">{t("status.absent")}</th>
                        <th scope="col" className="px-4 py-3 font-medium">{t("status.late")}</th>
                        <th scope="col" className="px-4 py-3 font-medium">{t("dashboard.attendanceRate")}</th>
                        <th scope="col" className="px-4 py-3 font-medium">{t("field.duration")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {memberPageRows.map((row) => (
                          <tr key={`${row.memberId}|${row.courseId}`} className="border-b border-line last:border-b-0">
                            <td className="px-4 py-3 font-medium text-ink">{row.memberName}</td>
                            <td className="px-4 py-3 text-ink">{row.courseTitle}</td>
                            <td className="px-4 py-3 text-ink">{row.sessions}</td>
                            <td className="px-4 py-3 text-ink">{row.present}</td>
                            <td className="px-4 py-3 text-ink">{row.absent}</td>
                            <td className="px-4 py-3 text-ink">{row.late}</td>
                            <td className="px-4 py-3 text-ink">{row.rate}%</td>
                            <td className="px-4 py-3 whitespace-nowrap text-ink">{t("duration.hours", { hours: row.attendedHours })}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm text-muted">{t("attendance.page", { page: currentPage, pages: pageCount })}</p>
                  <div className="flex gap-2">
                    <Button className="max-sm:min-h-11" variant="soft" disabled={currentPage <= 1} onClick={() => setDashboardPage((p) => Math.max(1, p - 1))}>
                      {t("attendance.prevPage")}
                    </Button>
                    <Button className="max-sm:min-h-11" variant="soft" disabled={currentPage >= pageCount} onClick={() => setDashboardPage((p) => Math.min(pageCount, p + 1))}>
                      {t("attendance.nextPage")}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
        {dashboardTab === "trainers" && trainerSummary && (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <p>
                <span className="font-semibold text-ink">{trainerSummary.totalSessions}</span> <span className="text-muted">{t("session.title")}</span>
              </p>
              <p>
                <span className="font-semibold text-ink">{trainerSummary.overallRate}%</span> <span className="text-muted">{t("dashboard.attendanceRate")}</span>
              </p>
              <p>
                <span className="font-semibold text-ink">{t("duration.hours", { hours: trainerSummary.totalHoursTaught })}</span>{" "}
                <span className="text-muted">{t("field.duration")}</span>
              </p>
            </div>
            {trainerSummary.rows.length === 0 ? (
              <p className="text-sm text-muted">{t("attendance.noData")}</p>
            ) : (
              <>
                <div role="region" tabIndex={0} aria-label={t("attendance.dashboard")} className="relative overflow-x-auto rounded-card border border-line bg-surface">
                  <table className="w-full min-w-[44rem] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-muted">
                        <th scope="col" className="px-4 py-3 font-medium">{t("field.trainer")}</th>
                        <th scope="col" className="px-4 py-3 font-medium">{t("field.course")}</th>
                        <th scope="col" className="px-4 py-3 font-medium">{t("session.title")}</th>
                        <th scope="col" className="px-4 py-3 font-medium">{t("status.present")}</th>
                        <th scope="col" className="px-4 py-3 font-medium">{t("status.absent")}</th>
                        <th scope="col" className="px-4 py-3 font-medium">{t("dashboard.attendanceRate")}</th>
                        <th scope="col" className="px-4 py-3 font-medium">{t("field.duration")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trainerPageRows.map((row) => (
                        <tr key={`${row.trainerId}|${row.courseId}`} className="border-b border-line last:border-b-0">
                          <td className="px-4 py-3 font-medium text-ink">{row.trainerName}</td>
                          <td className="px-4 py-3 text-ink">{row.courseTitle}</td>
                          <td className="px-4 py-3 text-ink">{row.sessions}</td>
                          <td className="px-4 py-3 text-ink">{row.present}</td>
                          <td className="px-4 py-3 text-ink">{row.absent}</td>
                          <td className="px-4 py-3 text-ink">{row.rate}%</td>
                          <td className="px-4 py-3 whitespace-nowrap text-ink">{t("duration.hours", { hours: row.hoursTaught })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm text-muted">{t("attendance.page", { page: currentPage, pages: pageCount })}</p>
                  <div className="flex gap-2">
                    <Button className="max-sm:min-h-11" variant="soft" disabled={currentPage <= 1} onClick={() => setDashboardPage((p) => Math.max(1, p - 1))}>
                      {t("attendance.prevPage")}
                    </Button>
                    <Button className="max-sm:min-h-11" variant="soft" disabled={currentPage >= pageCount} onClick={() => setDashboardPage((p) => Math.min(pageCount, p + 1))}>
                      {t("attendance.nextPage")}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </section>

      <GuideDialog open={guideOpen} section="attendance" onClose={() => setGuideOpen(false)} />

      <Modal open={newSessionOpen} onOpenChange={setNewSessionOpen} title={t("session.add")}>
        <div className="flex flex-col gap-4">
          <Field label={t("field.date")} htmlFor="new-session-date">
            <DatePicker id="new-session-date" value={newDate} onChange={setNewDate} />
          </Field>
          <Field label={t("field.topic")} htmlFor="new-session-topic">
            <input id="new-session-topic" className={inputClass} value={newTopic} onChange={(e) => setNewTopic(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("field.startTime")} htmlFor="new-session-start">
              <TimePicker id="new-session-start" ariaLabel={t("field.startTime")} value={newStartTime} onChange={setNewStartTime} />
            </Field>
            <Field label={t("field.endTime")} htmlFor="new-session-end">
              <TimePicker id="new-session-end" ariaLabel={t("field.endTime")} value={newEndTime} onChange={setNewEndTime} />
            </Field>
          </div>
          <Field label={t("field.capacity")} htmlFor="new-session-capacity" hint={t("hint.sessionCapacity")}>
            <input id="new-session-capacity" type="number" min={1} step={1} inputMode="numeric" className={inputClass} value={newCapacity} onChange={(e) => setNewCapacity(e.target.value)} />
          </Field>
          <Field label={t("field.trainer")}>
            <TrainerPicker
              name="new-session-trainer"
              trainers={rankedNewSessionTrainers}
              requiredSkills={selectedCourse ? courseRequiredSkills(selectedCourse) : []}
              value={newTrainerId}
              onChange={setNewTrainerId}
              label={t("field.trainer")}
              emptyMessage={t("session.noQualifiedTrainer")}
            />
          </Field>
          {newSessionError && (
            <p role="alert" className="text-sm text-danger">
              {newSessionError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button className="max-sm:min-h-11" variant="ghost" onClick={() => setNewSessionOpen(false)}>
              {t("action.cancel")}
            </Button>
            <Button
              className="max-sm:min-h-11"
              onClick={() => void createNewSession()}
              disabled={!newDate || !newTopic.trim() || !/^\d{2}:\d{2}$/.test(newStartTime) || !/^\d{2}:\d{2}$/.test(newEndTime) || rankedNewSessionTrainers.length === 0}
            >
              {t("action.add")}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
