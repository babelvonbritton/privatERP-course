"use client";

import { useEffect, type DependencyList } from "react";
import { errorCenter } from "@/lib/errors/ErrorCenter";

/**
 * Runs an async load in an effect and guards it after unmount: the load
 * receives an alive() check, errors it does not handle itself are reported
 * with the given action, and a cleanup the load returns runs when the
 * effect ends. The load runs again whenever deps change.
 */
export function useLoadOnce(
  load: (alive: () => boolean) => Promise<void | (() => void)> | void | (() => void),
  action: string,
  deps: DependencyList = [],
): void {
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | void;
    const alive = () => !cancelled;
    void Promise.resolve()
      .then(() => load(alive))
      .then((c) => {
        cleanup = c ?? undefined;
        if (cancelled) cleanup?.();
      })
      .catch((e) => {
        if (!cancelled) errorCenter.report(e, { action });
      });
    return () => {
      cancelled = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
