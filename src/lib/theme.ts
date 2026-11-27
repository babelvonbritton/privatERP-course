import { LocalPrefs } from "./storage/LocalPrefs";

export type ThemeChoice = "system" | "light" | "dark";

type ResolvedTheme = "light" | "dark";

const KEY = "theme";
const STORAGE_KEY = "olaseena.theme";

/** The stored choice, or "system" when nothing valid was stored. */
export function getStoredTheme(): ThemeChoice {
  const stored = LocalPrefs.get(KEY);
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

/** Resolve a stored choice against the device preference. */
export function resolveTheme(stored: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  if (stored === "light") return "light";
  if (stored === "dark") return "dark";
  return systemPrefersDark ? "dark" : "light";
}

/** True when the device prefers dark and the browser can say so. */
export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Show a resolved theme: toggle the class the stylesheet keys off, which also flips color-scheme. */
export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

/** Persist a choice and show it right away. */
export function setTheme(choice: ThemeChoice): void {
  LocalPrefs.set(KEY, choice);
  applyTheme(resolveTheme(choice, systemPrefersDark()));
}

/**
 * Keep the shown theme in sync after load: a change in another tab, and a
 * device-preference change while the choice is "system". Returns a cleanup
 * that removes both listeners.
 */
export function initThemeSync(): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    applyTheme(resolveTheme(getStoredTheme(), systemPrefersDark()));
  };
  const media =
    typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const onMediaChange = () => {
    if (getStoredTheme() === "system") applyTheme(resolveTheme("system", systemPrefersDark()));
  };
  window.addEventListener("storage", onStorage);
  media?.addEventListener("change", onMediaChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    media?.removeEventListener("change", onMediaChange);
  };
}
