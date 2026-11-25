import type { Table } from "dexie";
import type { Clock } from "./types";

/** Generic CRUD shared by every repository; subclasses add store-specific queries. */
export abstract class BaseRepository<T, K extends string> {
  constructor(
    protected readonly table: Table<T, K>,
    protected readonly clock: Clock = Date.now,
    /** Called after a successful write, so the app can react to data changes. Settings stores never pass one. */
    protected readonly onWrite?: () => void,
  ) {}

  get(key: K): Promise<T | undefined> {
    return this.table.get(key);
  }

  all(): Promise<T[]> {
    return this.table.toArray();
  }

  count(): Promise<number> {
    return this.table.count();
  }

  async put(record: T): Promise<K> {
    const key = await this.table.put(record);
    this.onWrite?.();
    return key;
  }

  async remove(key: K): Promise<void> {
    await this.table.delete(key);
    this.onWrite?.();
  }
}
