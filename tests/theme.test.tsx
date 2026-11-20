// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeSection } from "@/components/settings/ThemeSection";
import {
  applyTheme,
  getStoredTheme,
  initThemeSync,
  resolveTheme,
  setTheme,
  systemPrefersDark,
} from "@/lib/theme";
import { Providers } from "./support";

const KEY = "olaseena.theme";

/** Controllable matchMedia stub: flip `matches` and fire the change listeners. */
function stubMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  const media = {
    matches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: vi.fn((_type: string, fn: () => void) => {
      listeners.add(fn);
    }),
    removeEventListener: vi.fn((_type: string, fn: () => void) => {
      listeners.delete(fn);
    }),
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => media),
  });
  return {
    setMatches(next: boolean) {
      matches = next;
      Object.defineProperty(media, "matches", { configurable: true, value: next });
    },
    fireChange() {
      listeners.forEach((fn) => fn());
    },
  };
}

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stored choice defaults to system and rejects unknown values", () => {
    expect(getStoredTheme()).toBe("system");
    localStorage.setItem(KEY, "dark");
    expect(getStoredTheme()).toBe("dark");
    localStorage.setItem(KEY, "light");
    expect(getStoredTheme()).toBe("light");
    localStorage.setItem(KEY, "system");
    expect(getStoredTheme()).toBe("system");
    localStorage.setItem(KEY, "sepia");
    expect(getStoredTheme()).toBe("system");
  });

  it("resolveTheme follows the stored choice, or the device when the choice is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("systemPrefersDark reads the device preference and stays false without matchMedia", () => {
    stubMatchMedia(true);
    expect(systemPrefersDark()).toBe(true);
    stubMatchMedia(false);
    expect(systemPrefersDark()).toBe(false);
  });

  it("applyTheme toggles the dark class on documentElement", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("setTheme persists the choice and applies it at once", () => {
    const media = stubMatchMedia(false);
    setTheme("dark");
    expect(localStorage.getItem(KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    setTheme("light");
    expect(localStorage.getItem(KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    media.setMatches(true);
    setTheme("system");
    expect(localStorage.getItem(KEY)).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("a storage event from another tab re-applies the stored choice", () => {
    const cleanup = initThemeSync();
    try {
      localStorage.setItem(KEY, "dark");
      window.dispatchEvent(new window.StorageEvent("storage", { key: KEY }));
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      localStorage.setItem(KEY, "light");
      window.dispatchEvent(new window.StorageEvent("storage", { key: KEY }));
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      localStorage.setItem("olaseena.locale", "id");
      window.dispatchEvent(new window.StorageEvent("storage", { key: "olaseena.locale" }));
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("a device-preference change re-applies while the choice is system, and not otherwise", () => {
    const media = stubMatchMedia(false);
    const cleanup = initThemeSync();
    try {
      media.setMatches(true);
      media.fireChange();
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      setTheme("light");
      media.setMatches(false);
      media.fireChange();
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      media.setMatches(true);
      media.fireChange();
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("ThemeSection shows the three options and applies a pick immediately", () => {
    stubMatchMedia(false);
    render(
      <Providers>
        <ThemeSection />
      </Providers>,
    );
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect((screen.getByRole("radio", { name: "Follow system" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(localStorage.getItem(KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect((screen.getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(localStorage.getItem(KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
