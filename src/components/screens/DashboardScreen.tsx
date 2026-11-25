"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/types";
import { formatDate } from "@/lib/dates";
import { getServices, today, type DashboardData } from "@/lib/domain/services";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { formatMoney } from "@/lib/money";
import { GuideDialog } from "../GuideDialog";
import type { NavId } from "../nav";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

/** Upcoming sessions per dashboard page. */
const PAGE_SIZE = 5;

/** One figure on the dashboard: a small muted label above a large value. */
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 truncate text-2xl font-semibold text-plum-900">{value}</p>
    </div>
  );
}

/** Overview screen: money, attendance and what is coming next, computed from stored data. */
export function DashboardScreen({ navigate }: { navigate: (id: NavId) => void }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<DashboardData | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [page, setPage] = useState(1);

  // The attendance dashboard pagination, reused: clamp the page to what
  // exists and slice the rows for it.
  const pageCount = Math.max(1, Math.ceil((data?.upcomingSessions.length ?? 0) / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageSessions = (data?.upcomingSessions ?? []).slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Back to page 1 whenever the upcoming list itself changes, so the view
  // never sits on a page that no longer exists.
  const upcomingCount = data?.upcomingSessions.length ?? 0;
  useEffect(() => {
    setPage(1);
  }, [upcomingCount]);

  const load = useCallback(async () => {
    try {
      setData(await getServices().dashboard.get(today()));
    } catch (e) {
      errorCenter.report(e, { action: "dashboard.load" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div data-tour="dashboard" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-plum-900">{t("dashboard.title")}</h1>
        <button
          type="button"
          aria-label={t("guide.open")}
          onClick={() => setGuideOpen(true)}
          className="grid size-10 max-sm:size-11 shrink-0 place-items-center rounded-full border border-line bg-surface text-plum-600 transition-colors duration-200 hover:bg-plum-50"
        >
          <Icon name="help" size={18} />
        </button>
      </div>
      <GuideDialog open={guideOpen} section="dashboard" onClose={() => setGuideOpen(false)} />

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label={t("dashboard.revenueMonth")} value={formatMoney(data.revenueCollectedThisMonth, locale)} />
            <StatCard label={t("dashboard.outstanding")} value={formatMoney(data.outstandingTotal, locale)} />
            <StatCard label={t("dashboard.attendanceRate")} value={`${data.attendanceRate}%`} />
            <StatCard label={t("dashboard.activeMembers")} value={String(data.activeMembers)} />
          </div>

          {data.overdueCount > 0 ? (
            <div className="rounded-card border border-danger/40 bg-danger/5 p-4">
              <p className="text-sm font-medium text-danger">{t("dashboard.overdue")}</p>
              <p className="mt-1 text-sm text-ink">
                {data.overdueCount} {formatMoney(data.overdueTotal, locale)}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted">{t("dashboard.noOverdue")}</p>
          )}

          <section className="rounded-card border border-line bg-surface p-4">
            <h2 className="text-base font-semibold text-plum-900">{t("dashboard.upcoming")}</h2>
            {data.upcomingSessions.length === 0 ? (
              <p className="mt-3 text-sm text-muted">{t("dashboard.noUpcoming")}</p>
            ) : (
              <>
                <ul className="mt-3 flex flex-col divide-y divide-line">
                  {pageSessions.map((session) => (
                    <li key={session.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink">{session.topic}</p>
                        <p className="mt-0.5 text-sm text-muted">
                          {session.courseTitle}
                          {session.trainerName ? ` · ${session.trainerName}` : ""}
                        </p>
                      </div>
                      <p className="shrink-0 text-sm text-muted">{formatDate(session.date, locale)}</p>
                    </li>
                  ))}
                </ul>
                {pageCount > 1 && (
                  <div className="mt-4 flex items-center justify-between gap-2">
                    <p className="text-sm text-muted">{t("attendance.page", { page: currentPage, pages: pageCount })}</p>
                    <div className="flex gap-2">
                      <Button className="max-sm:min-h-11" variant="soft" disabled={currentPage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                        {t("attendance.prevPage")}
                      </Button>
                      <Button className="max-sm:min-h-11" variant="soft" disabled={currentPage >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>
                        {t("attendance.nextPage")}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="rounded-card border border-line bg-surface p-4">
            <h2 className="text-base font-semibold text-plum-900">{t("dashboard.recentInvoices")}</h2>
            {data.recentInvoices.length === 0 ? (
              <p className="mt-3 text-sm text-muted">{t("dashboard.noInvoices")}</p>
            ) : (
              <div role="region" tabIndex={0} aria-label={t("dashboard.recentInvoices")} className="relative mt-3 overflow-x-auto">
                <table className="w-full min-w-96 border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-muted">
                      <th scope="col" className="py-2 pr-3 font-medium">{t("diff.number")}</th>
                      <th scope="col" className="py-2 pr-3 font-medium">{t("diff.member")}</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">{t("diff.total")}</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">{t("diff.paid")}</th>
                      <th scope="col" className="py-2 font-medium">{t("diff.status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentInvoices.map((invoice) => (
                      <tr key={invoice.id} className="border-b border-line last:border-0">
                        <td className="py-2 pr-3 font-medium whitespace-nowrap text-ink">{invoice.number}</td>
                        <td className="py-2 pr-3 whitespace-nowrap text-ink">{invoice.memberName}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap text-ink">{formatMoney(invoice.total, locale)}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap text-ink">{formatMoney(invoice.paidAmount, locale)}</td>
                        <td className="py-2 whitespace-nowrap text-ink">{t(`status.${invoice.status}` as MessageKey)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-4">
              <Button className="max-sm:min-h-11" variant="soft" onClick={() => navigate("invoices")}>
                {t("dashboard.viewAll")}
              </Button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
