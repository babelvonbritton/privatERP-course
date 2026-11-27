"use client";

import { useState } from "react";
import { useI18n } from "@/i18n";
import { GuideDialog } from "./GuideDialog";
import { Icon } from "./ui/Icon";

type GuideButtonVariant = "default" | "large" | "bordered";

const BUTTON_CLASS: Record<GuideButtonVariant, string> = {
  default:
    "grid size-8 max-sm:size-11 place-items-center rounded-full text-muted transition-colors duration-200 hover:bg-plum-50 hover:text-ink",
  large:
    "grid size-8 max-sm:size-11 shrink-0 place-items-center rounded-full text-muted transition-colors duration-200 hover:bg-plum-100 hover:text-ink",
  bordered:
    "grid size-10 max-sm:size-11 shrink-0 place-items-center rounded-full border border-line bg-surface text-plum-600 transition-colors duration-200 hover:bg-plum-50",
};

/**
 * On-demand help button for one screen: opens that screen's guide dialog.
 * Owns its open state, unless open and onOpenChange are given: then the
 * caller owns it, so another control (like a dialog's help button) can open
 * the same guide.
 */
export function GuideButton({
  section,
  variant = "default",
  open,
  onOpenChange,
}: {
  section: string;
  variant?: GuideButtonVariant;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setIsOpen = onOpenChange ?? setInternalOpen;
  return (
    <>
      <button type="button" onClick={() => setIsOpen(true)} aria-label={t("guide.open")} className={BUTTON_CLASS[variant]}>
        <Icon name="help" size={variant === "default" ? 16 : 18} />
      </button>
      <GuideDialog open={isOpen} section={section} onClose={() => setIsOpen(false)} />
    </>
  );
}
