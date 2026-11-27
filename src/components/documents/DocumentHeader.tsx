"use client";

import type { ReactNode } from "react";
import type { BusinessProfile } from "@/lib/storage/BusinessProfileService";
import { LambdaMark } from "@/components/Logo";

/**
 * Fixed light colors for printable documents, written inline and never
 * theme tokens, so a dark theme can never change what an export looks
 * like. Text contrast is at least 4.5:1 on white throughout.
 */
export const DOCUMENT_PALETTE = {
  ink: "#2B1E2B",
  muted: "#5C4A5C",
  accent: "#5B2A52",
  line: "#E5DDDE",
  soft: "#F8F5F0",
} as const;

/**
 * Printable document header: logo (or lambda mark), business name and
 * tagline on the left, the document's own heading on the right, and the
 * address and contacts underneath.
 */
export function DocumentHeader({ profile, logoDataUrl, right }: { profile: BusinessProfile; logoDataUrl: string | null; right: ReactNode }) {
  const businessName = profile.businessName.trim() || "Olaseena";
  const tagline = profile.tagline.trim();
  const address = profile.address.trim();
  const contacts = profile.contacts.map((c) => c.trim()).filter((c) => c.length > 0);
  const { ink, muted, accent } = DOCUMENT_PALETTE;

  return (
    <>
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
        <div style={{ maxWidth: "100%", textAlign: "right" }}>{right}</div>
      </div>

      {(address || contacts.length > 0) && (
        <div style={{ marginTop: 12, fontSize: 13, color: muted }}>
          {address && <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{address}</div>}
          {contacts.map((contact) => (
            <div key={contact} style={{ overflowWrap: "anywhere" }}>{contact}</div>
          ))}
        </div>
      )}
    </>
  );
}
