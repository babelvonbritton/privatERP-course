import { createId } from "@/lib/storage/utils";
import type { StorageService } from "@/lib/storage";
import type { Clock } from "@/lib/storage/types";
import type { Actor, AuditLogEntry } from "./types";

type Db = StorageService["db"];

/** Shared base for the domain services: actor stamping, the audit log, and idempotency keys. */
export abstract class ServiceBase {
  constructor(
    protected readonly storage: StorageService,
    protected actor: Actor,
    protected readonly clock: Clock = Date.now,
  ) {}

  /** Builds one audit entry for the given actor, without writing it. */
  static buildAuditEntry(actor: Actor, at: number, action: string, entity: string, entityId: string, detail: string): AuditLogEntry {
    return {
      id: createId(),
      orgId: actor.orgId,
      actorId: actor.id,
      actorName: "Owner",
      action,
      entity,
      entityId,
      detail,
      at,
    };
  }

  /** Re-stamps this service with a new actor. New records and audit entries from here on use it; records already written keep theirs. */
  setActor(actor: Actor): void {
    this.actor = actor;
  }

  protected get db(): Db {
    return this.storage.db;
  }

  protected now(): number {
    return this.clock();
  }

  protected async audit(action: string, entity: string, entityId: string, detail: string): Promise<void> {
    await this.storage.audit.add(ServiceBase.buildAuditEntry(this.actor, this.now(), action, entity, entityId, detail));
  }

  /** Returns the entity id a write key already produced, or null when the key is new. */
  protected async seenKey(key: string, entity: string): Promise<string | null> {
    const seen = await this.storage.writeKeys.get(key);
    return seen && seen.entity === entity ? seen.entityId : null;
  }

  protected async recordKey(key: string, entity: string, entityId: string): Promise<void> {
    await this.storage.writeKeys.put({ key, entity, entityId, createdAt: this.now() });
  }
}
