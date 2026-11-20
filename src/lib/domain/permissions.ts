import { AppError } from "@/lib/errors/AppError";
import type { Actor } from "./types";

/**
 * Permission gate for every service call. Today there is one actor, the owner, who
 * may do everything. A future multi-user server keeps the same call sites and
 * checks the actor's role here instead of changing the services.
 */
export function can(actor: Actor, _action: string): boolean {
  return actor.role === "owner";
}

/** Throws FORBIDDEN unless the actor may perform the action. */
export function requireCan(actor: Actor, action: string): void {
  if (!can(actor, action)) throw new AppError("FORBIDDEN", { details: `${actor.id} may not ${action}` });
}
