"use client";

import { useEffect, useState } from "react";
import { useI18n, type MessageKey } from "@/i18n";
import { formatMoney } from "@/lib/money";
import { formatDate, dateOf } from "@/lib/dates";
import { sessionDurationHours, type Course, type PayrollRun, type Session } from "@/lib/domain/types";
import { DEFAULT_BUSINESS_PROFILE, type BusinessProfile } from "@/lib/storage/BusinessProfileService";
import { LambdaMark } from "@/components/Logo";
import { errorCenter } from "@/lib/errors/ErrorCenter";

function blobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("logo could not be converted to a data URL"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("logo could not be read"));
    reader.readAsDataURL(blob);
  });
}

/** Sorts sessions soonest first: date, then start time, then topic. */
function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) =>
    a.date !== b.date
      ? a.date.localeCompare(b.date)
      : a.startTime !== b.startTime
        ? a.startTime.localeCompare(b.startTime)
        : a.topic.localeCompare(b.topic),
  );
}

/**
 * Printable paycheck. All colors are fixed light values written inline, never
 * theme tokens, so a dark theme can never change what an export looks like.
 * Text contrast is at least 4.5:1 on white throughout. The amounts come from
 * the run as it stands: the per-session rate and total are the run's own, and
 * the itemized rows are the run's paid sessions. A draft run is labeled Draft
 * because it recomputes from current attendance; a paid run never changes.
 */
export function PaycheckDocument({
  run,
  trainerName,
  paidSessions,
  unpaidSessions,
  courseById,
  profile = DEFAULT_BUSINESS_PROFILE,
  logoBlob = null,
}: {
  run: PayrollRun;
  trainerName: string;
  paidSessions: Session[];
  unpaidSessions: Session[];
  courseById: Map<string, Course>;
  /** Business profile shown in the header. Defaults to the placeholder: the Olaseena wordmark, no tagline, address or contacts. The owner's name is never shown. */
  profile?: BusinessProfile;
  /** Uploaded logo bytes, or null when the profile has none. */
  logoBlob?: Blob | null;
}) {
  const { t, locale } = useI18n();
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);

  // The logo converts the same way the invoice logo does, and the export waits
  // for it too: a PDF or PNG taken mid-conversion would ship the placeholder.
  useEffect(() => {
    let cancelled = false;
    setLogoDataUrl(null);
    setLogoFailed(false);
    if (!logoBlob) return;
    void blobAsDataUrl(logoBlob)
      .then((url) => {
        if (!cancelled) setLogoDataUrl(url);
      })
      .catch((e) => {
        if (!cancelled) {
          errorCenter.report(e, { action: "paycheck.logo.read" });
          setLogoFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [logoBlob]);

  const logoReady = !logoBlob || logoDataUrl !== null || logoFailed;
  const attachmentStatus = logoReady ? "true" : "false";

  const businessName = profile.businessName.trim() || "Olaseena";
  const tagline = profile.tagline.trim();
  const address = profile.address.trim();
  const contacts = profile.contacts.map((c) => c.trim()).filter((c) => c.length > 0);
  const paidAt = run.paidAt ? dateOf(run.paidAt) : null;
  const sortedPaid = sortSessions(paidSessions);
  const sortedUnpaid = sortSessions(unpaidSessions);
  const isPaid = run.status === "paid";

  const ink = "#2B1E2B";
  const muted = "#5C4A5C";
  const accent = "#5B2A52";
  const line = "#E5DDDE";
  const soft = "#F8F5F0";

  return (
    <div
      data-testid="paycheck-document"
      data-attachments-ready={attachmentStatus}
      style={{ width: "min(640px, 100%)", maxWidth: 640, minWidth: 0, backgroundColor: "#FFFFFF", color: ink, fontFamily: "system-ui, -apple-system, sans-serif", padding: "clamp(8px, 3vw, 32px)", boxSizing: "border-box" }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: accent }}>
          {logoDataUrl ? (
            <img src={logoDataUrl} alt="" style={{ display: "block", height: 40, maxWidth: 120, objectFit: "contain" }} />
          ) : (
            <LambdaMark size={28} />
          )}
          <div>
            <span style={{ fontSize: 26, fontWeight: 700, color: ink }}>{businessName}</span>
            {tagline && <div style={{ fontSize: 13, fontWeight: 400, color: muted }}>{tagline}</div>}
          </div>
        </div>
        <div style={{ maxWidth: "100%", textAlign: "right" }}>
          <div style={{ fontSize: 20, fontWeight: 700, overflowWrap: "anywhere" }}>{t("paycheck.title")}</div>
          <div style={{ marginTop: 6 }}>
            <span
              style={{
                display: "inline-block",
                padding: "3px 12px",
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 700,
                border: `2px solid ${accent}`,
                backgroundColor: isPaid ? accent : "#FFFFFF",
                color: isPaid ? "#FFFFFF" : accent,
              }}
            >
              {t(isPaid ? "status.paid" : "status.draft")}
            </span>
          </div>
        </div>
      </div>

      {(address || contacts.length > 0) && (
        <div style={{ marginTop: 12, fontSize: 13, color: muted }}>
          {address && <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{address}</div>}
          {contacts.map((contact) => (
            <div key={contact} style={{ overflowWrap: "anywhere" }}>{contact}</div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 12, marginTop: 28, fontSize: 14 }}>
        <div>
          <div style={{ fontSize: 12, color: muted }}>{t("field.trainer")}</div>
          <div style={{ fontWeight: 600, marginTop: 2 }}>{trainerName}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 12, color: muted }}>{t("payroll.period")}</div>
          <div style={{ fontWeight: 600, marginTop: 2 }}>
            {formatDate(run.periodStart, locale)} – {formatDate(run.periodEnd, locale)}
          </div>
          {paidAt && (
            <div style={{ marginTop: 4, fontSize: 12, color: muted }}>
              {t("payroll.paidAt")}: {formatDate(paidAt, locale)}
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{t("payroll.paidSessions")}</div>
        {sortedPaid.length === 0 ? (
          <p style={{ marginTop: 8, fontSize: 14, color: muted }}>{t("paycheck.noPaidSessions")}</p>
        ) : (
          <div role="region" tabIndex={0} aria-label={t("payroll.paidSessions")} style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${ink}`, textAlign: "left" }}>
                  <th scope="col" style={{ padding: "8px 2px 8px 0", fontWeight: 600 }}>{t("field.date")}</th>
                  <th scope="col" style={{ padding: "8px 2px", fontWeight: 600 }}>{t("field.course")}</th>
                  <th scope="col" style={{ padding: "8px 2px", fontWeight: 600, textAlign: "right" }}>{t("field.duration")}</th>
                  <th scope="col" style={{ padding: "8px 2px", fontWeight: 600, textAlign: "right" }}>{t("payroll.rate")}</th>
                  <th scope="col" style={{ padding: "8px 0 8px 2px", fontWeight: 600, textAlign: "right" }}>{t("field.amount")}</th>
                </tr>
              </thead>
              <tbody>
                {sortedPaid.map((s) => {
                  const hours = sessionDurationHours(s);
                  return (
                    <tr key={s.id} style={{ borderBottom: `1px solid ${line}` }}>
                      <td style={{ padding: "8px 2px 8px 0" }}>
                        <div style={{ whiteSpace: "nowrap" }}>{formatDate(s.date, locale)}</div>
                        {s.startTime && s.endTime && (
                          <div style={{ fontSize: 11, color: muted, whiteSpace: "nowrap" }}>{s.startTime}–{s.endTime}</div>
                        )}
                      </td>
                      <td style={{ padding: "8px 2px" }}>
                        <div style={{ fontWeight: 600 }}>{courseById.get(s.courseId)?.title ?? ""}</div>
                        <div style={{ fontSize: 12, color: muted }}>{s.topic}</div>
                      </td>
                      <td style={{ padding: "8px 2px", textAlign: "right", whiteSpace: "nowrap" }}>
                        {hours === null ? "-" : t("duration.hours", { hours })}
                      </td>
                      <td style={{ padding: "8px 2px", textAlign: "right" }}>{formatMoney(run.ratePerSession, locale)}</td>
                      <td style={{ padding: "8px 0 8px 2px", textAlign: "right" }}>{formatMoney(run.ratePerSession, locale)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ marginTop: 16, marginLeft: "auto", width: "min(260px, 100%)", maxWidth: 260, fontSize: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
          <span>{t("payroll.sessionCount")}</span>
          <span>{run.sessionCount}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
          <span>{t("payroll.rate")}</span>
          <span>{formatMoney(run.ratePerSession, locale)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderTop: `1px solid ${line}`, fontWeight: 700 }}>
          <span>{t("payroll.total")}</span>
          <span>{formatMoney(run.total, locale)}</span>
        </div>
      </div>

      {sortedUnpaid.length > 0 && (
        <div style={{ marginTop: 24, borderTop: `1px solid ${line}`, paddingTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{t("payroll.unpaidSessions")}</div>
          <p style={{ marginTop: 4, fontSize: 12, color: muted }}>{t("payroll.unpaidHint")}</p>
          <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none" }}>
            {sortedUnpaid.map((s) => (
              <li key={s.id} style={{ padding: "8px 0", borderBottom: `1px solid ${line}`, fontSize: 14 }}>
                <div style={{ fontWeight: 600 }}>
                  {formatDate(s.date, locale)}
                  {s.startTime && s.endTime ? ` ${s.startTime}–${s.endTime}` : ""} - {s.topic}
                </div>
                <div style={{ fontSize: 12, color: muted }}>
                  {courseById.get(s.courseId)?.title ?? ""} · {t(s.trainerPresent ? "status.present" : "status.absent")}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!isPaid && (
        <p style={{ marginTop: 24, fontSize: 12, color: muted }}>{t("paycheck.draftHint")}</p>
      )}
    </div>
  );
}
