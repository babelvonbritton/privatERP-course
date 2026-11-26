"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/types";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { getStorage } from "@/lib/storage";
import type { NavId } from "./nav";
import { Button } from "./ui/Button";

export interface TourStep {
  nav: NavId;
  target: string;
  step: string;
}

/** One step per screen, in the order a new user meets them. */
export const TOUR_STEPS: TourStep[] = [
  { nav: "dashboard", target: "dashboard", step: "dashboard" },
  { nav: "members", target: "members", step: "members" },
  { nav: "trainers", target: "trainers", step: "trainers" },
  { nav: "courses", target: "courses", step: "courses" },
  // Same screen as the courses step, so the tour does not navigate again
  // here: the section sits below the course table on the same screen.
  { nav: "courses", target: "course-sessions", step: "courseSessions" },
  { nav: "attendance", target: "attendance", step: "attendance" },
  { nav: "invoices", target: "invoices", step: "invoices" },
  { nav: "payroll", target: "payroll", step: "payroll" },
  { nav: "trash", target: "trash", step: "trash" },
  { nav: "settings", target: "settings", step: "settings" },
  // The business profile sits at the top of Settings, so it comes right
  // after the intro and before the Drive section below it: the tour walks
  // the screen top to bottom instead of scrolling down and back up.
  { nav: "settings", target: "profile", step: "profile" },
  { nav: "settings", target: "drive", step: "drive" },
];

interface TourContextValue {
  /** Opens the tour from the first step (used by Settings to replay it). */
  startTour: () => void;
}

const TourContext = createContext<TourContextValue>({ startTour: () => {} });
export function useTour(): TourContextValue {
  return useContext(TourContext);
}

interface Props {
  navigate: (id: NavId) => void;
  children: ReactNode;
}

/** Owns the first-run tour: auto-shows once, replays on demand, and never blocks the app. */
export function TourProvider({ navigate, children }: Props) {
  const [index, setIndex] = useState<number | null>(null);

  const endTour = useCallback(() => {
    setIndex(null);
    void getStorage().preferences.set("tourSeen", true);
  }, []);

  const startTour = useCallback(() => setIndex(0), []);

  // First run: show the tour once, shortly after the app loads. Focus stays where it is.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void getStorage()
        .preferences.load()
        .then(({ preferences }) => {
          if (!cancelled && !preferences.tourSeen) setIndex(0);
        })
        .catch((e) => errorCenter.report(e, { action: "tour.load" }));
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const step = index === null ? null : TOUR_STEPS[index];

  // The tour moves between screens by navigating. When two steps share one
  // screen (settings, then its Drive section), navigating again would scroll
  // back to the top after the overlay scrolled the section into view, so
  // only navigate when the screen actually changes.
  const lastNav = useRef<NavId | null>(null);
  useEffect(() => {
    if (step && step.nav !== lastNav.current) {
      lastNav.current = step.nav;
      navigate(step.nav);
    }
  }, [step, navigate]);

  return (
    <TourContext.Provider value={{ startTour }}>
      {children}
      {step && index !== null && (
        <TourOverlay
          step={step}
          isFirst={index === 0}
          isLast={index === TOUR_STEPS.length - 1}
          onBack={() => setIndex((i) => (i === null || i === 0 ? i : i - 1))}
          onNext={() => {
            if (index === TOUR_STEPS.length - 1) endTour();
            else setIndex(index + 1);
          }}
          onSkip={endTour}
        />
      )}
    </TourContext.Provider>
  );
}

interface OverlayProps {
  step: TourStep;
  isFirst: boolean;
  isLast: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}

/**
 * A dimmed backdrop with a hole over the highlighted element, plus a tooltip with Back, Next and Skip.
 * The tooltip is always kept fully inside the viewport: it goes below the target when it fits there,
 * above it when that fits, and is centered (and scrollable) when neither side has room. Clicking the
 * dimmed backdrop ends the tour, so the user is never trapped behind the overlay. On a phone the
 * tooltip becomes a bottom sheet docked above the bottom bar instead: the ring would circle the
 * whole screen and say nothing, so it is dropped and the dim is lightened to let the screen read
 * through, while the sheet stays short enough that the screen above it stays visible.
 */
function TourOverlay({ step, isFirst, isLast, onBack, onNext, onSkip }: OverlayProps) {
  const { t } = useI18n();
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [tip, setTip] = useState<{ width: number; height: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // Height of the fixed mobile bottom bar, so the narrow sheet docks directly
  // above it with no floating gap. Measured for real because the bar grows
  // with the safe-area inset on phones with a home indicator.
  const [navH, setNavH] = useState(56);

  useEffect(() => {
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    if (!el) {
      setRect(null);
      return;
    }
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
    const measure = () => {
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    const timer = setTimeout(measure, 200);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", measure);
    };
  }, [step]);

  // Measure the tooltip itself so placement uses its real size, not a guess.
  useLayoutEffect(() => {
    const el = tooltipRef.current;
    if (!el) return;
    const measureTip = () => {
      const r = el.getBoundingClientRect();
      setTip((prev) => (prev && prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
    };
    measureTip();
    window.addEventListener("resize", measureTip);
    return () => window.removeEventListener("resize", measureTip);
  }, [rect, step]);

  // Escape ends the whole tour, the same as Skip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSkip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip]);

  const title = t(`tour.step.${step.step}.title` as MessageKey);
  const body = t(`tour.step.${step.step}.body` as MessageKey);
  const isNarrow = typeof window !== "undefined" && window.innerWidth < 640;

  // On a phone, measure the bottom bar so the sheet sits flush on top of it.
  useEffect(() => {
    if (!isNarrow) return;
    const measureNav = () => {
      const nav = document.querySelector("nav.fixed");
      if (!nav) return;
      // Keep the fractional height: rounding it would leave a sub-pixel seam
      // between the sheet and the bar (the bar's own top is fractional too).
      const h = nav.getBoundingClientRect().height;
      setNavH((prev) => (h > 0 && Math.abs(h - prev) > 0.25 ? h : prev));
    };
    measureNav();
    window.addEventListener("resize", measureNav);
    return () => window.removeEventListener("resize", measureNav);
  }, [isNarrow]);

  // Desktop placement, clamped inside the viewport. Until the tooltip is measured, use a rough size.
  // On a phone the sheet below ignores this and docks above the bottom bar instead.
  const tooltipStyle: CSSProperties = (() => {
    if (!rect || isNarrow) return {};
    const tipH = tip?.height ?? 280;
    const tipW = tip?.width ?? 320;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const margin = 12;
    const edge = 8;
    const belowTop = rect.top + rect.height + margin;
    const aboveTop = rect.top - margin - tipH;
    let top: number;
    if (belowTop + tipH <= vh - edge) top = belowTop;
    else if (aboveTop >= edge) top = aboveTop;
    else top = Math.max(edge, Math.min((vh - tipH) / 2, vh - tipH - edge));
    const left = Math.max(edge, Math.min(rect.left, vw - tipW - edge));
    return { left, top };
  })();

  // Narrow screens get a bottom sheet instead of a floating card: full width,
  // rounded top corners, docked flush above the bottom bar, capped at 45dvh
  // so the screen above stays visible, with its own scroll when the text runs
  // long. The sheet style below is the only narrow-only branch; the desktop
  // classes and placement above are unchanged.
  const sheetClass = isNarrow
    ? "fixed inset-x-0 z-10 max-h-[45dvh] w-full overflow-y-auto overscroll-contain rounded-t-[22px] bg-surface px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 shadow-xl"
    : `fixed z-10 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-sm overflow-y-auto rounded-card bg-surface p-4 shadow-xl sm:w-80 ${!rect ? "bottom-24 left-4 right-4 sm:left-1/2 sm:right-auto sm:-translate-x-1/2" : ""}`;
  const sheetStyle: CSSProperties = isNarrow ? { bottom: navH } : tooltipStyle;

  return (
    <div className="fixed inset-0 z-50" aria-hidden={false} onClick={onSkip}>
      {rect && !isNarrow && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-card border-2 border-white transition-all duration-200"
          style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8, boxShadow: "0 0 0 9999px rgba(43, 30, 43, 0.55)" }}
        />
      )}
      {isNarrow && <div aria-hidden="true" className="absolute inset-0" style={{ backgroundColor: "rgba(43, 30, 43, 0.35)" }} />}
      <div
        ref={tooltipRef}
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={sheetClass}
        style={sheetStyle}
      >
        {isNarrow && <div aria-hidden="true" className="mx-auto mb-2 h-1 w-9 rounded-full bg-plum-200" />}
        <p className="text-xs font-medium uppercase tracking-wide text-plum-600">{t("tour.title")}</p>
        <h2 className="mt-1 text-base font-semibold text-ink">{title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-ink/90">{body}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <button type="button" onClick={onSkip} className="text-sm text-muted underline-offset-2 hover:text-ink hover:underline max-sm:flex max-sm:min-h-11 max-sm:items-center max-sm:px-1">
            {t("tour.skip")}
          </button>
          <div className="flex gap-2">
            {!isFirst && (
              <Button variant="ghost" className="h-9 px-3 text-sm max-sm:h-11" onClick={onBack}>
                {t("tour.back")}
              </Button>
            )}
            <Button className="h-9 px-4 text-sm max-sm:h-11" onClick={onNext}>
              {isLast ? t("tour.finish") : t("tour.next")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
