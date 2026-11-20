"use client";

import { useEffect } from "react";
import { applyTheme, getStoredTheme, initThemeSync, resolveTheme, systemPrefersDark } from "@/lib/theme";

/** Applies the stored theme on mount and keeps it in sync with other tabs and the device setting. Renders nothing. */
export function ThemeSync() {
  useEffect(() => {
    applyTheme(resolveTheme(getStoredTheme(), systemPrefersDark()));
    return initThemeSync();
  }, []);
  return null;
}
