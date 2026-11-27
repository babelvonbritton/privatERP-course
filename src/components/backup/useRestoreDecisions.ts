"use client";

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { Decision } from "@/lib/backup/MergePlanner";
import type { RestorePlan } from "@/lib/backup/types";

/**
 * Owns the per-entry restore decisions for a restore review: which
 * differences to apply and which to skip. Deciding all applies only to
 * entries that differ, never to identical ones.
 */
export function useRestoreDecisions(plan: RestorePlan | null): {
  decisions: Map<string, Decision>;
  onDecide: (key: string, decision: Decision) => void;
  onDecideAll: (decision: Decision) => void;
  setDecisions: Dispatch<SetStateAction<Map<string, Decision>>>;
} {
  const [decisions, setDecisions] = useState<Map<string, Decision>>(new Map());
  const onDecide = useCallback((key: string, decision: Decision) => {
    setDecisions((m) => new Map(m).set(key, decision));
  }, []);
  const onDecideAll = useCallback(
    (decision: Decision) => {
      if (!plan) return;
      setDecisions(new Map(plan.merge.entries.filter((e) => e.status === "differs").map((e) => [e.key, decision] as const)));
    },
    [plan],
  );
  return { decisions, onDecide, onDecideAll, setDecisions };
}
