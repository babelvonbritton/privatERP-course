"use client";

import { useEffect, useState } from "react";
import { useI18n, type MessageKey } from "@/i18n";
import { formatMoney } from "@/lib/money";
import { formatDate, dateOf } from "@/lib/dates";
import { paymentDetailsOf, paymentMethodOf } from "@/lib/invoicePayment";
import type { Invoice } from "@/lib/domain/types";
import { DEFAULT_BUSINESS_PROFILE, type BusinessProfile } from "@/lib/storage/BusinessProfileService";
import { LambdaMark } from "@/components/Logo";
import { errorCenter } from "@/lib/errors/ErrorCenter";

interface InvoiceDocumentAttachment {
  id: string;
  fileName: string;
  blob: Blob | null;
}

const EMPTY_ATTACHMENTS: InvoiceDocumentAttachment[] = [];

function blobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("attachment could not be converted to a data URL"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("attachment could not be read"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Printable invoice. All colors are fixed light values written inline, never
 * theme tokens, so a dark theme can never change what an export looks like.
 * Text contrast is at least 4.5:1 on white throughout.
 */
export function InvoiceDocument({
  invoice,
  memberName,
  attachments = EMPTY_ATTACHMENTS,
  profile = DEFAULT_BUSINESS_PROFILE,
  logoBlob = null,
}: {
  invoice: Invoice;
  memberName: string;
  attachments?: InvoiceDocumentAttachment[];
  /** Business profile shown in the header. Defaults to the placeholder: the Olaseena wordmark, no tagline, address or contacts. The owner's name is never shown. */
  profile?: BusinessProfile;
  /** Uploaded logo bytes, or null when the profile has none. */
  logoBlob?: Blob | null;
}) {
  const { t, locale } = useI18n();
  const remaining = invoice.total - invoice.paidAmount;
  const issueDate = dateOf(invoice.createdAt);
  const method = paymentMethodOf(invoice);
  const details = paymentDetailsOf(invoice);
  const showPayment = method !== "cash";
  const [loadedAttachments, setLoadedAttachments] = useState<{
    attachments: InvoiceDocumentAttachment[];
    dataUrls: Map<string, string>;
    failedIds: Set<string>;
  } | null>(null);
  /** The logo as an exportable image source, or null while it is still converting. */
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);

  // The logo converts the same way attachment bytes do, and the export waits
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
          errorCenter.report(e, { action: "invoice.logo.read" });
          setLogoFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [logoBlob]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      attachments.map(async (attachment) => {
        if (!attachment.blob) return { id: attachment.id, dataUrl: null, failed: false };
        try {
          return { id: attachment.id, dataUrl: await blobAsDataUrl(attachment.blob), failed: false };
        } catch (e) {
          if (!cancelled) errorCenter.report(e, { action: "invoice.attachment.read" });
          return { id: attachment.id, dataUrl: null, failed: true };
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const dataUrls = new Map<string, string>();
      const failedIds = new Set<string>();
      for (const result of results) {
        if (result.dataUrl) dataUrls.set(result.id, result.dataUrl);
        if (result.failed) failedIds.add(result.id);
      }
      setLoadedAttachments({ attachments, dataUrls, failedIds });
    });
    return () => {
      cancelled = true;
    };
  }, [attachments]);

  const currentAttachments = loadedAttachments?.attachments === attachments ? loadedAttachments : null;
  const hasAttachmentBlobs = attachments.some((attachment) => attachment.blob !== null);
  const attachmentsReady = !hasAttachmentBlobs || currentAttachments !== null;
  // The logo counts toward readiness too: with no logo there is nothing to
  // wait for, and a failed conversion falls back to the placeholder.
  const logoReady = !logoBlob || logoDataUrl !== null || logoFailed;
  const attachmentStatus = !attachmentsReady || !logoReady
    ? "false"
    : currentAttachments && currentAttachments.failedIds.size > 0
      ? "error"
      : "true";

  const businessName = profile.businessName.trim() || "Olaseena";
  const tagline = profile.tagline.trim();
  const address = profile.address.trim();
  const contacts = profile.contacts.map((c) => c.trim()).filter((c) => c.length > 0);

  const ink = "#2B1E2B";
  const muted = "#5C4A5C";
  const accent = "#5B2A52";
  const line = "#E5DDDE";
  const soft = "#F8F5F0";

  return (
    <div
      data-testid="invoice-document"
      data-attachments-ready={attachmentStatus}
      style={{ width: "min(640px, 100%)", maxWidth: 640, minWidth: 0, backgroundColor: "#FFFFFF", color: ink, fontFamily: "system-ui, -apple-system, sans-serif", padding: "clamp(16px, 5vw, 32px)", boxSizing: "border-box" }}
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
          <div style={{ fontSize: 20, fontWeight: 700, overflowWrap: "anywhere" }}>{invoice.number}</div>
          <div style={{ fontSize: 13, color: muted }}>
            {t("invoice.issueDate")}: {formatDate(issueDate, locale)}
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

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 28, fontSize: 14 }}>
        <div>
          <div style={{ fontSize: 12, color: muted }}>{t("invoice.member")}</div>
          <div style={{ fontWeight: 600, marginTop: 2 }}>{memberName}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 12, color: muted }}>{t("invoice.dueDate")}</div>
          <div style={{ fontWeight: 600, marginTop: 2 }}>{formatDate(invoice.dueDate, locale)}</div>
        </div>
      </div>

      <table style={{ width: "100%", marginTop: 24, borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr style={{ borderBottom: `2px solid ${ink}`, textAlign: "left" }}>
            <th scope="col" style={{ padding: "8px 0", fontWeight: 600 }}>{t("field.description")}</th>
            <th scope="col" style={{ padding: "8px 0", fontWeight: 600, textAlign: "right" }}>{t("field.amount")}</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lineItems.map((item, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${line}` }}>
              <td style={{ padding: "8px 0" }}>{item.description}</td>
              <td style={{ padding: "8px 0", textAlign: "right", whiteSpace: "nowrap" }}>{formatMoney(item.amount, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 16, marginLeft: "auto", width: "min(260px, 100%)", maxWidth: 260, fontSize: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
          <span>{t("invoice.total")}</span>
          <strong>{formatMoney(invoice.total, locale)}</strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
          <span>{t("invoice.paid")}</span>
          <span>{formatMoney(invoice.paidAmount, locale)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderTop: `1px solid ${line}`, fontWeight: 700 }}>
          <span>{t("invoice.balance")}</span>
          <span>{formatMoney(remaining, locale)}</span>
        </div>
      </div>

      {showPayment && (
        <div data-testid="invoice-payment-block" style={{ marginTop: 24, backgroundColor: soft, border: `1px solid ${line}`, borderRadius: 8, padding: 16, fontSize: 14 }}>
          <div style={{ fontWeight: 700 }}>{t("invoice.paymentDetails")}</div>
          <div style={{ marginTop: 6 }}>
            {t("invoice.payTo")}: {t(`method.${method}` as MessageKey)}
          </div>
          {details && <div style={{ marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{details}</div>}
        </div>
      )}

      {attachments.length > 0 && (
        <div data-testid="invoice-attachments" style={{ marginTop: 24, borderTop: `1px solid ${line}`, paddingTop: 16 }}>
          <div style={{ marginBottom: 12, fontSize: 14, fontWeight: 700 }}>{t("attachment.title")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {attachments.map((attachment) => {
              const src = currentAttachments?.dataUrls.get(attachment.id);
              return (
                <div key={attachment.id} style={{ fontSize: 12, color: muted }}>
                  {src ? (
                    <img
                      src={src}
                      alt={attachment.fileName}
                      style={{ display: "block", maxWidth: "100%", maxHeight: 320, objectFit: "contain", marginBottom: 6 }}
                    />
                  ) : !attachment.blob || currentAttachments ? (
                    <div style={{ marginBottom: 6 }}>{t("attachment.missing")}</div>
                  ) : null}
                  <div style={{ overflowWrap: "anywhere" }}>{attachment.fileName}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
