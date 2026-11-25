"use client";

import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "@/i18n";
import { timeToMinutes } from "@/lib/domain/types";
import { Icon } from "./Icon";

const pad = (n: number) => String(n).padStart(2, "0");
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

/** Hour and minute of an HH:MM string, falling back to 09:00 when it is missing or malformed. */
function parseTime(value: string): { hour: number; minute: number } {
  const minutes = timeToMinutes(value);
  if (minutes === null) return { hour: 9, minute: 0 };
  return { hour: Math.floor(minutes / 60), minute: minutes % 60 };
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  ariaLabel: string;
}

/**
 * Time picker: a popover panel with hour and minute columns in the site palette.
 * It replaces the native time input, whose rendering varies by browser and ignores
 * the theme. Arrow keys move within a column, Enter picks, Escape closes; picking
 * a minute closes the panel because the value is complete then.
 */
export function TimePicker({ value, onChange, id, ariaLabel }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { hour, minute } = parseTime(value);
  const valid = timeToMinutes(value) !== null;
  const hourRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const minuteRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [hourFocus, setHourFocus] = useState(hour);
  const [minuteFocus, setMinuteFocus] = useState(minute);

  useEffect(() => {
    if (!open) return;
    setHourFocus(hour);
    setMinuteFocus(minute);
    hourRefs.current[hour]?.scrollIntoView({ block: "nearest" });
    minuteRefs.current[minute]?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  const pickHour = (h: number) => {
    setHourFocus(h);
    onChange(`${pad(h)}:${pad(minute)}`);
  };

  const pickMinute = (m: number) => {
    setMinuteFocus(m);
    onChange(`${pad(hour)}:${pad(m)}`);
    setOpen(false);
  };

  /** Arrow keys, Home and End move focus inside one column; the focused option stays the tab stop. */
  const moveFocus = (e: KeyboardEvent<HTMLDivElement>, column: "hour" | "minute") => {
    const max = column === "hour" ? 23 : 59;
    const current = column === "hour" ? hourFocus : minuteFocus;
    const setFocus = column === "hour" ? setHourFocus : setMinuteFocus;
    const refs = column === "hour" ? hourRefs : minuteRefs;
    let next: number | null = null;
    if (e.key === "ArrowDown") next = Math.min(max, current + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    setFocus(next);
    refs.current[next]?.focus();
  };

  const optionClass = (selected: boolean) =>
    `h-9 w-full shrink-0 rounded-[8px] text-sm transition-colors duration-150 max-sm:min-h-11 ${
      selected ? "bg-plum-600 font-medium text-white" : "text-ink hover:bg-plum-100"
    }`;

  const column = (kind: "hour" | "minute") => {
    const values = kind === "hour" ? HOURS : MINUTES;
    const selected = kind === "hour" ? hour : minute;
    const focused = kind === "hour" ? hourFocus : minuteFocus;
    const setFocus = kind === "hour" ? setHourFocus : setMinuteFocus;
    const refs = kind === "hour" ? hourRefs : minuteRefs;
    const pick = kind === "hour" ? pickHour : pickMinute;
    return (
      <div role="group" aria-label={t(`time.${kind}`)} onKeyDown={(e) => moveFocus(e, kind)} className="flex min-w-0 flex-1 flex-col">
        <span className="pb-1 text-center text-xs font-medium text-muted">{t(`time.${kind}`)}</span>
        <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto pr-0.5">
          {values.map((v) => (
            <button
              key={v}
              ref={(el) => {
                refs.current[v] = el;
              }}
              type="button"
              tabIndex={v === focused ? 0 : -1}
              aria-pressed={v === selected}
              onFocus={() => setFocus(v)}
              onClick={() => pick(v)}
              className={optionClass(v === selected)}
            >
              {pad(v)}
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        id={id}
        aria-label={ariaLabel}
        className="group flex h-10 w-full items-center justify-between gap-2 rounded-control border border-line bg-surface px-3 text-sm transition-[border-color,box-shadow] duration-200 hover:border-plum-200 data-[state=open]:border-plum-600 data-[state=open]:shadow-[0_0_0_3px_rgba(91,42,82,0.12)]"
      >
        <span className={valid ? "text-ink" : "text-muted/70"}>{valid ? value : t("time.pick")}</span>
        <Icon name="clock" size={16} className="text-muted" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} align="start" className="anim-pop z-[80] w-56 rounded-card border border-line bg-surface p-3 shadow-[0_16px_36px_-14px_rgba(43,30,43,0.3)] outline-none">
          <div className="flex gap-2">
            {column("hour")}
            {column("minute")}
          </div>
          <div className="mt-2 flex justify-end border-t border-line pt-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-control px-2 py-1 text-sm font-medium text-plum-600 transition-colors hover:bg-plum-50">
              {t("time.done")}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
