"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { getServices, type AttendanceDashboardSummary, type TrainerDashboardSummary } from "@/lib/domain/services";
import type { AttendanceStatus, Course, Enrollment, Member, Session, Trainer } from "@/lib/domain/types";
import { sessionAttendees, sessionDurationHours, sessionEffectiveAttendees } from "@/lib/domain/types";
import { formatDate } from "@/lib/dates";
import { createId } from "@/lib/storage/utils";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { Button } from "../ui/Button";
import { TableShell, Td, Th } from "../ui/Table";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Field } from "../ui/Field";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { Icon } from "../ui/Icon";
import { GuideButton } from "../GuideButton";
import type { NavId } from "../nav";

const NONE = "__none__";

const ALL = "all";
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
  const [markedSessionIds, setMarkedSessionIds] = useState<string[]>([]);
  const [unmarkOpen, setUnmarkOpen] = useState(false);

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
  const refreshMarked = useCallback(async (id: string) => {
    try {
      setMarkedSessionIds(await getServices().attendance.listMarkedSessionIds(id));
    } catch (e) {
      errorCenter.report(e, { action: "attendance.marked" });
    }
  }, []);

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
    setMarkedSessionIds([]);
    if (id === NONE) {
      setSessions([]);
      return;
    }
    try {
      const [found, marked] = await Promise.all([
        getServices().attendance.listSessionsByCourse(id),
        getServices().attendance.listMarkedSessionIds(id),
      ]);
      setSessions([...found].sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || "").localeCompare(b.startTime || "") || a.topic.localeCompare(b.topic)));
      setMarkedSessionIds(marked);
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
      const effectiveIds = found ? new Set(sessionEffectiveAttendees(found, active.map((a) => a.memberId))) : new Set<string>();
      const rowIds = new Set(rows.map((r) => r.memberId));
      const listed = active.filter((e) => effectiveIds.has(e.memberId) || rowIds.has(e.memberId));
      setEnrollments(listed);
      const saved = new Map(rows.map((r) => [r.memberId, r.status]));
      const next: Record<string, AttendanceStatus> = {};
      for (const e of listed) next[e.memberId] = saved.get(e.memberId) ?? "present";
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
      if (courseId !== NONE) void refreshMarked(courseId);
      void loadDashboard(filterTrainer, filterMember, filterCourse);
    } catch (e) {
      errorCenter.report(e, { action: "attendance.mark" });
    } finally {
      setSaving(false);
    }
  };

  /** Clears the open session's marks after confirmation: it goes back to unmarked. */
  const confirmUnmarkSession = async () => {
    if (!session) return;
    try {
      await getServices().attendance.unmarkSession(session.id);
      errorCenter.notify({ key: "attendance.unmarked" });
      setUnmarkOpen(false);
      if (courseId !== NONE) void refreshMarked(courseId);
      await chooseSession(session.id);
      void loadDashboard(filterTrainer, filterMember, filterCourse);
    } catch (e) {
      errorCenter.report(e, { action: "attendance.unmark" });
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
          <GuideButton section="attendance" variant="large" />
        </div>
      </div>

      <div className="rounded-card border border-line bg-surface p-4">
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

      {courseId === NONE ? (
        <div className="rounded-card border border-line bg-surface px-6 py-12 text-center">
          <p className="text-base font-medium text-ink">{t("attendance.pickCourseFirst")}</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-card border border-line bg-surface px-6 py-12 text-center">
          <p className="text-base font-medium text-ink">{t("attendance.noSessions")}</p>
          <p className="mt-1 text-sm text-muted">{t("attendance.noSessionsHint")}</p>
        </div>
      ) : (
        <section aria-label={t("session.title")} className="overflow-hidden rounded-card border border-line bg-surface">
          <h2 className="border-b border-line px-4 py-3 text-base font-semibold text-plum-900">{t("session.title")}</h2>
          <ul className="flex flex-col divide-y divide-line">
            {sessions.map((s) => {
              const marked = markedSessionIds.includes(s.id);
              const selected = sessionId === s.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => void chooseSession(s.id)}
                    aria-current={selected ? "true" : undefined}
                    className={`flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left text-sm transition-colors duration-200 ${
                      selected ? "bg-plum-100 font-medium text-plum-900" : "bg-surface text-ink hover:bg-plum-50"
                    }`}
                  >
                    <span>
                      {formatDate(s.date, locale)}
                      {timeLabel(s)} - {s.topic}
                    </span>
                    {marked && (
                      <span className="rounded-full bg-plum-600 px-2 py-0.5 text-xs font-medium text-white">{t("attendance.marked")}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {courseId !== NONE && !session && (
        <div className="rounded-card border border-line bg-surface px-6 py-12 text-center">
          <p className="text-base font-medium text-ink">{t("attendance.empty")}</p>
          <p className="mt-1 text-sm text-muted">{t("attendance.emptyHint")}</p>
        </div>
      )}
      {courseId !== NONE && session && enrollments.length === 0 && (
        <div className="rounded-card border border-line bg-surface px-6 py-12 text-center">
          <p className="text-base font-medium text-ink">
            {sessionAttendees(session) === null ? t("attendance.noAssignedMembers") : t("attendance.noListedMembers")}
          </p>
        </div>
      )}
      {session && enrollments.length > 0 && (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <div className="border-b border-line px-4 py-3">
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-plum-900">
              <span>
                {formatDate(session.date, locale)}
                {timeLabel(session)} - {session.topic}
              </span>
              {markedSessionIds.includes(session.id) && (
                <span className="rounded-full bg-plum-600 px-2 py-0.5 text-xs font-medium text-white">{t("attendance.marked")}</span>
              )}
            </p>
            <p className="text-xs text-muted">{selectedCourse?.title ?? ""}</p>
            {sessionAttendees(session) !== null && (
              <p className="mt-1 text-xs text-muted">{t("attendance.assignedOnly")}</p>
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
          <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">
            {markedSessionIds.includes(session.id) && (
              <Button variant="dangerSoft" icon="restore" onClick={() => setUnmarkOpen(true)} className="max-sm:min-h-11">
                {t("attendance.unmark")}
              </Button>
            )}
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
                <TableShell label={t("attendance.dashboard")} minWidth="44rem">
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
                  </TableShell>
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
                <TableShell label={t("attendance.dashboard")} minWidth="44rem">
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
                  </TableShell>
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


      <ConfirmDialog
        open={unmarkOpen}
        title={t("attendance.unmark")}
        body={t("attendance.unmarkBody")}
        confirmLabel={t("attendance.unmark")}
        cancelLabel={t("action.cancel")}
        danger
        onConfirm={() => void confirmUnmarkSession()}
        onCancel={() => setUnmarkOpen(false)}
      />
    </div>
  );
}
