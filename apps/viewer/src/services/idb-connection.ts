/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared connection lifecycle; schema creation/recovery stays with each store. */
export class IdbConnectionLifecycle {
  private promise: Promise<IDBDatabase> | null = null;
  private database: IDBDatabase | null = null;

  constructor(private readonly logPrefix: string) {}

  open(create: () => Promise<IDBDatabase>): Promise<IDBDatabase> {
    if (this.promise) return this.promise;
    const pending = create().then((db) => {
      db.onversionchange = () => {
        db.close();
        this.invalidate(db);
      };
      db.onclose = () => this.invalidate(db);
      this.database = db;
      return db;
    }, (error: unknown) => {
      // A failed older open must not clear a concurrent replacement.
      if (this.promise === pending) this.reset();
      throw error;
    });
    this.promise = pending;
    return pending;
  }

  /** Schema recovery may deliberately replace the currently opening database. */
  reset(): void {
    this.promise = null;
    this.database = null;
  }

  private invalidate(db: IDBDatabase): void {
    if (this.database === db) this.reset();
  }

  /** `use` must synchronously create a transaction before any persistent effect.
   * Only a closed connection's synchronous InvalidStateError is retried, once;
   * request/commit errors are never replayed (#3331, #2102). */
  async withConnection<T>(
    open: () => Promise<IDBDatabase>, use: (db: IDBDatabase) => T,
  ): Promise<T> {
    const db = await open();
    try {
      return use(db);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'InvalidStateError') throw error;
      console.warn(`${this.logPrefix} Connection closed; reopening once`, error);
      this.invalidate(db);
      return use(await open());
    }
  }
}
