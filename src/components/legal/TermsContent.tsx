"use client";

import { LegalPage } from "./LegalPage";

const SECTIONS = ["service", "data", "use", "warranty", "changes"] as const;
const UPDATED = new Date(2026, 10, 25);

export function TermsContent() {
  return <LegalPage namespace="terms" sections={SECTIONS} updated={UPDATED} />;
}
