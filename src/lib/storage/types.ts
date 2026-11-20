/** Storage-layer re-exports of the domain types, so the rest of the app imports from one place. */
export * from "@/lib/domain/types";

export type Clock = () => number;
