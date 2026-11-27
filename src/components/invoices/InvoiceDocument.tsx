"use client";

import { useState } from "react";
import { useI18n, type MessageKey } from "@/i18n";
import { formatMoney } from "@/lib/money";
import { formatDate, dateOf } from "@/lib/dates";
import { paymentDetailsOf, paymentMethodOf } from "@/lib/invoicePayment";
import type { Invoice } from "@/lib/domain/types";
import { DEFAULT_BUSINESS_PROFILE, type BusinessProfile } from "@/lib/storage/BusinessProfileService";
import { blobAsDataUrl } from "@/lib/blob";
import { DOCUMENT_PALETTE, DocumentHeader } from "@/components/documents/DocumentHeader";
import { useBusinessLogo } from "@/components/documents/useBusinessLogo";
import { useLoadOnce } from "@/lib/hooks/useLoadOnce";
import { errorCenter } from "@/lib/errors/ErrorCenter";

interface InvoiceDocumentAttachment {
  id: string;
  fileName: string;
  blob: Blob | null;
}

const EMPTY_ATTACHMENTS: InvoiceDocumentAttachment[] = [];

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
  profile?: BusinessProfile;
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
  const { logoDataUrl, logoFailed, logoReady } = useBusinessLogo(logoBlob, "invoice.logo.read");

  useLoadOnce(async (alive) => {
    const results = await Promise.all(
      attachments.map(async (attachment) => {
        if (!attachment.blob) return { id: attachment.id, dataUrl: null, failed: false };
        try {
          return { id: attachment.id, dataUrl: await blobAsDataUrl(attachment.blob, "attachment"), failed: false };
        } catch (e) {
          if (alive()) errorCenter.report(e, { action: "invoice.attachment.read" });
          return { id: attachment.id, dataUrl: null, failed: true };
        }
      }),
    );
    if (!alive()) return;
    const dataUrls = new Map<string, string>();
    const failedIds = new Set<string>();
    for (const result of results) {
      if (result.dataUrl) dataUrls.set(result.id, result.dataUrl);
      if (result.failed) failedIds.add(result.id);
    }
    setLoadedAttachments({ attachments, dataUrls, failedIds });
  }, "invoice.attachment.read", [attachments]);

  const currentAttachments = loadedAttachments?.attachments === attachments ? loadedAttachments : null;
  const hasAttachmentBlobs = attachments.some((attachment) => attachment.blob !== null);
  const attachmentsReady = !hasAttachmentBlobs || currentAttachments !== null;
  const attachmentStatus = !attachmentsReady || !logoReady
    ? "false"
    : currentAttachments && currentAttachments.failedIds.size > 0
      ? "error"
      : "true";

  const { ink, muted, line, soft } = DOCUMENT_PALETTE;

  return (
    <div
      data-testid="invoice-document"
      data-attachments-ready={attachmentStatus}
      style={{ width: "min(640px, 100%)", maxWidth: 640, minWidth: 0, backgroundColor: "#FFFFFF", color: ink, fontFamily: "system-ui, -apple-system, sans-serif", padding: "clamp(16px, 5vw, 32px)", boxSizing: "border-box" }}
    >
      <DocumentHeader
        profile={profile}
        logoDataUrl={logoDataUrl}
        right={
          <>
            <div style={{ fontSize: 20, fontWeight: 700, overflowWrap: "anywhere" }}>{invoice.number}</div>
            <div style={{ fontSize: 13, color: muted }}>
              {t("invoice.issueDate")}: {formatDate(issueDate, locale)}
            </div>
          </>
        }
      />

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
