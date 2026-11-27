"use client";

import { LegalPage } from "./LegalPage";

const SECTIONS = ["local", "tracking", "hosting", "backups", "control", "limits", "terms", "changes"] as const;
const UPDATED = new Date(2026, 10, 20);

export function PrivacyContent() {
  return <LegalPage namespace="privacy" sections={SECTIONS} updated={UPDATED} sectionId={(s) => (s === "terms" ? "terms" : undefined)} />;
}
