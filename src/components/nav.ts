import type { IconName } from "./ui/Icon";

export type NavId = "dashboard" | "members" | "trainers" | "courses" | "attendance" | "invoices" | "payroll" | "trash" | "settings";

export interface NavItem {
  id: NavId;
  icon: IconName;
  labelKey: `nav.${NavId}`;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", icon: "home", labelKey: "nav.dashboard" },
  { id: "members", icon: "users", labelKey: "nav.members" },
  { id: "trainers", icon: "user", labelKey: "nav.trainers" },
  { id: "courses", icon: "book", labelKey: "nav.courses" },
  { id: "attendance", icon: "clipboardCheck", labelKey: "nav.attendance" },
  { id: "invoices", icon: "receipt", labelKey: "nav.invoices" },
  { id: "payroll", icon: "wallet", labelKey: "nav.payroll" },
  { id: "trash", icon: "trash", labelKey: "nav.trash" },
  { id: "settings", icon: "gear", labelKey: "nav.settings" },
];

export const MOBILE_NAV_IDS: NavId[] = ["dashboard", "members", "courses", "invoices"];
export const MORE_NAV_IDS: NavId[] = ["trainers", "attendance", "payroll", "trash", "settings"];
