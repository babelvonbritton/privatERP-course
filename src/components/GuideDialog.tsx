"use client";

import { useI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/types";
import { Button } from "./ui/Button";
import { Icon } from "./ui/Icon";
import { Modal } from "./ui/Modal";

const GUIDE_ITEMS: Record<string, string[]> = {
  dashboard: ["money", "next", "profile"],
  members: ["add", "find", "detail"],
  trainers: ["add", "find", "detail"],
  courses: ["add", "enroll", "detail", "assign"],
  attendance: ["sessions", "mark", "trainer", "dashboard"],
  invoices: ["pay", "status"],
  payroll: ["generate", "paid"],
  trash: ["restore", "empty"],
  settings: ["profile", "language", "backup", "tour"],
};

interface Props {
  open: boolean;
  section: string;
  onClose: () => void;
}

/** On-demand help for one screen: what it is for and what can be done there. Never opens by itself. */
export function GuideDialog({ open, section, onClose }: Props) {
  const { t } = useI18n();
  const items = GUIDE_ITEMS[section] ?? [];
  return (
    <Modal open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t(`guide.${section}.title` as MessageKey)}>
      <p className="text-sm text-ink/90">{t(`guide.${section}.intro` as MessageKey)}</p>
      <ul className="mt-4 flex flex-col gap-4">
        {items.map((item) => (
          <li key={item} className="flex gap-3">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-plum-100 text-plum-600">
              <Icon name="check" size={13} strokeWidth={2.6} />
            </span>
            <div>
              <p className="text-sm font-medium text-ink">{t(`guide.${section}.${item}` as MessageKey)}</p>
              <p className="mt-0.5 text-sm text-muted">{t(`guide.${section}.${item}Desc` as MessageKey)}</p>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-6 flex justify-end">
        <Button onClick={onClose}>{t("action.done")}</Button>
      </div>
    </Modal>
  );
}
