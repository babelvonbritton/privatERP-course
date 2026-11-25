"use client";

import { useId, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { dedupeSkills } from "@/lib/domain/types";
import { Icon } from "./Icon";

interface TagInputProps {
  id: string;
  /** Current skills, in display order. */
  value: string[];
  onChange: (value: string[]) => void;
  /** Every skill already used anywhere, for suggestions. */
  suggestions: string[];
  placeholder: string;
  disabled?: boolean;
  /** Maximum chips; extra adds are ignored. Defaults to 12. */
  maxItems?: number;
}

/**
 * Tag input for skills: type to see suggestions drawn from every skill
 * already used anywhere, pick one to add it, or confirm a new skill with
 * Enter, a comma, or the add row. Chips are removable. Skills dedupe
 * case-insensitively, keeping the first-seen casing.
 *
 * One input, one listbox: the text field is a combobox with an expanded
 * state and an active descendant, so keyboard and screen-reader users get
 * the same suggestions sighted users see. A typed value is committed on
 * blur too, so a phone keyboard's Done key never silently drops it.
 */
export function TagInput({ id, value, onChange, suggestions, placeholder, disabled = false, maxItems = 12 }: TagInputProps) {
  const { t } = useI18n();
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const query = text.trim();
  const pool = useMemo(() => dedupeSkills(suggestions), [suggestions]);
  const selectedLower = useMemo(() => new Set(value.map((v) => v.toLocaleLowerCase())), [value]);
  const matches = useMemo(() => {
    if (!query) return [];
    const q = query.toLocaleLowerCase();
    return pool.filter((s) => s.toLocaleLowerCase().includes(q) && !selectedLower.has(s.toLocaleLowerCase()));
  }, [pool, query, selectedLower]);
  const exactMatch = useMemo(() => pool.some((s) => s.toLocaleLowerCase() === query.toLocaleLowerCase()), [pool, query]);
  /** Rows in the listbox: matching suggestions first, then the create-new row when the typed skill is not used yet. */
  const rows: Array<{ kind: "suggestion" | "create"; label: string }> = useMemo(() => {
    const out: Array<{ kind: "suggestion" | "create"; label: string }> = matches.map((skill) => ({ kind: "suggestion" as const, label: skill }));
    if (query && !exactMatch && !selectedLower.has(query.toLocaleLowerCase())) {
      out.push({ kind: "create" as const, label: query });
    }
    return out;
  }, [matches, query, exactMatch, selectedLower]);
  const listOpen = open && rows.length > 0 && !disabled;
  const activeId = listOpen ? `${listboxId}-option-${Math.min(active, rows.length - 1)}` : undefined;

  const add = (skill: string) => {
    const clean = skill.trim();
    if (!clean || value.length >= maxItems) return;
    if (selectedLower.has(clean.toLocaleLowerCase())) {
      setText("");
      setOpen(false);
      return;
    }
    onChange([...value, clean]);
    setText("");
    setOpen(false);
    setActive(0);
    inputRef.current?.focus();
  };

  const remove = (skill: string) => {
    onChange(value.filter((v) => v.toLocaleLowerCase() !== skill.toLocaleLowerCase()));
    inputRef.current?.focus();
  };

  const commitText = () => {
    if (query) add(query);
    else setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <div
        className={`flex min-h-11 flex-wrap items-center gap-1.5 rounded-control border border-line bg-surface px-2 py-1.5 transition-[border-color,box-shadow] duration-200 hover:border-plum-200 focus-within:border-plum-600 focus-within:shadow-[0_0_0_3px_rgba(91,42,82,0.12)] ${disabled ? "opacity-60" : ""}`}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((skill) => (
          <span key={skill.toLocaleLowerCase()} className="inline-flex items-center gap-1 rounded-full bg-plum-100 py-1 pl-2.5 pr-1 text-xs font-medium text-plum-900">
            {skill}
            <button
              type="button"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                remove(skill);
              }}
              aria-label={t("tagInput.remove", { skill })}
              className="relative grid size-5 place-items-center rounded-full text-plum-900 transition-colors hover:bg-plum-200 focus-visible:outline-2 focus-visible:outline-plum-600 after:absolute after:-inset-2.5 after:content-['']"
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => {
            if (text.trim()) setOpen(true);
          }}
          onBlur={(e) => {
            // A click inside this control (a suggestion, a chip button) keeps
            // the value uncommitted; leaving the control commits typed text.
            if (containerRef.current?.contains(e.relatedTarget as Node)) return;
            commitText();
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && rows.length > 0) {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, rows.length - 1));
            } else if (e.key === "ArrowUp" && rows.length > 0) {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (listOpen && rows[Math.min(active, rows.length - 1)]) add(rows[Math.min(active, rows.length - 1)].label);
              else commitText();
            } else if (e.key === ",") {
              e.preventDefault();
              commitText();
            } else if (e.key === "Escape") {
              setOpen(false);
            } else if (e.key === "Backspace" && text === "" && value.length > 0) {
              remove(value[value.length - 1]);
            }
          }}
          role="combobox"
          aria-expanded={listOpen}
          aria-controls={listboxId}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          placeholder={value.length === 0 ? placeholder : ""}
          className="min-w-32 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted/70"
        />
      </div>
      {listOpen && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={t("tagInput.suggestions")}
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-control border border-line bg-surface p-1 shadow-[0_16px_36px_-14px_rgba(43,30,43,0.3)]"
        >
          {rows.map((row, i) => (
            <li
              key={`${row.kind}:${row.label.toLocaleLowerCase()}`}
              id={`${listboxId}-option-${i}`}
              role="option"
              aria-selected={i === Math.min(active, rows.length - 1)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(row.label)}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer select-none items-center gap-2 rounded-[8px] px-3 py-2 text-sm outline-none max-sm:min-h-11 ${i === Math.min(active, rows.length - 1) ? "bg-plum-50 font-medium text-plum-900" : "text-ink"}`}
            >
              {row.kind === "create" ? <Icon name="plus" size={14} /> : null}
              {row.kind === "create" ? t("tagInput.create", { skill: row.label }) : row.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
