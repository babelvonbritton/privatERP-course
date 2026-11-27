"use client";

import { useState } from "react";
import { blobAsDataUrl } from "@/lib/blob";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { useLoadOnce } from "@/lib/hooks/useLoadOnce";

/**
 * Loads a business logo blob as a data URL, reporting a failed read with the
 * given action. Ready when there is no logo, the data URL arrived, or the
 * read failed, so a missing logo never blocks the document.
 */
export function useBusinessLogo(logoBlob: Blob | null, errorAction: string): { logoDataUrl: string | null; logoFailed: boolean; logoReady: boolean } {
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);

  useLoadOnce(async (alive) => {
    setLogoDataUrl(null);
    setLogoFailed(false);
    if (!logoBlob) return;
    try {
      const url = await blobAsDataUrl(logoBlob, "logo");
      if (alive()) setLogoDataUrl(url);
    } catch (e) {
      if (alive()) {
        errorCenter.report(e, { action: errorAction });
        setLogoFailed(true);
      }
    }
  }, errorAction, [logoBlob, errorAction]);

  return { logoDataUrl, logoFailed, logoReady: !logoBlob || logoDataUrl !== null || logoFailed };
}
