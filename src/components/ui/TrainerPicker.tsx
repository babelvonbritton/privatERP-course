"use client";

import { useI18n } from "@/i18n";
import type { RankedTrainer, Trainer } from "@/lib/domain/types";

interface TrainerPickerProps {
  name: string;
  trainers: RankedTrainer<Trainer>[];
  requiredSkills: string[];
  value: string;
  onChange: (trainerId: string) => void;
  label: string;
  disabled?: boolean;
  disabledHint?: string;
  emptyMessage?: string;
}

/**
 * Trainer picker for a session: native radios, one per qualified trainer,
 * ranked by matching required skills with the count on each row so the
 * ranking is explainable. Native radios keep arrow-key navigation and
 * screen-reader announcements without custom key handling; the label wraps
 * the input so the whole row is the tap target (at least 44px on touch).
 */
export function TrainerPicker({ name, trainers, requiredSkills, value, onChange, label, disabled = false, disabledHint, emptyMessage }: TrainerPickerProps) {
  const { t } = useI18n();

  if (disabled) {
    return <p className="text-sm text-muted">{disabledHint ?? ""}</p>;
  }
  if (trainers.length === 0) {
    return (
      <p role="status" className="text-sm text-muted">
        {emptyMessage ?? ""}
      </p>
    );
  }
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-2">
      {trainers.map(({ trainer, matches }) => {
        const checked = value === trainer.id;
        return (
          <label
            key={trainer.id}
            className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-control border px-3 py-2 text-sm transition-colors duration-200 ${checked ? "border-plum-600 bg-plum-50 font-medium text-plum-900" : "border-line bg-surface text-ink hover:border-plum-200"}`}
          >
            <input
              type="radio"
              name={name}
              value={trainer.id}
              checked={checked}
              onChange={() => onChange(trainer.id)}
              className="size-4 shrink-0 accent-plum-600"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{trainer.name}</span>
              <span className="block truncate text-xs font-normal text-muted">
                {trainer.subjects.join(", ")}
                {requiredSkills.length > 0 ? ` · ${t("session.trainerMatches", { count: matches, required: requiredSkills.length })}` : ""}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
