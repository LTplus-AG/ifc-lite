/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tier-3 SQL lifecycle — manages a singleton DuckDB engine scoped to the
 * currently-active IFC model. The DuckDB-WASM package is OPTIONAL and
 * loads dynamically (`@duckdb/duckdb-wasm` isn't a direct dep); P4 has
 * to handle both "installed" and "not installed" paths gracefully.
 *
 * Invariants this module enforces:
 *   1. Never called during IFC load. The SQL tab only opens after a
 *      model is ready, and `ensureEngineFor(store)` is only invoked
 *      from inside the modal's Run handler.
 *   2. One engine instance total — swapping the active model disposes
 *      the previous one before building a new one. Prevents two
 *      multi-MB WASM workers from sitting around.
 *   3. Availability check is cached — `isDuckDBAvailable()` does the
 *      dynamic import once, then returns the cached boolean.
 */

import { DuckDBIntegration, type SQLResult } from '@ifc-lite/query';
import type { IfcDataStore } from '@ifc-lite/parser';

let cachedAvailable: boolean | null = null;
let activeEngine: DuckDBIntegration | null = null;
/** The store the current `activeEngine` was built from — used to detect model swaps. */
let activeStore: IfcDataStore | null = null;

/**
 * Single serial queue for every state-changing call (`ensureEngineFor`,
 * `disposeSqlEngine`). Each caller chains its work onto `queue` so two
 * concurrent calls can never overlap inside the
 * dispose-then-rebuild critical section. Without this, four interleaved
 * calls targeting different stores could leave an orphan engine
 * (queued init writes `activeEngine = X` after a dispose has already
 * cleared it) — see the race documented on the parent branch's PR
 * review.
 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  // Always continue from a resolved queue — `.catch(() => undefined)` so
  // an earlier failure never poisons later tasks. Each chained step sees
  // the latest module-level state inside its own turn.
  const next = queue.then(task);
  queue = next.catch(() => undefined);
  return next;
}

/** Cached availability probe — never throws. */
export async function isDuckDBAvailable(): Promise<boolean> {
  if (cachedAvailable !== null) return cachedAvailable;
  try {
    cachedAvailable = await DuckDBIntegration.isAvailable();
  } catch {
    cachedAvailable = false;
  }
  return cachedAvailable;
}

/**
 * Build (or reuse) the DuckDB engine for `store`. If a previous engine
 * exists for a different store, it's disposed first to release the WASM
 * worker + accumulated tables.
 *
 * Concurrency: every call queues behind the previous mutator, so two
 * concurrent calls for the same store both observe the engine the
 * first one built (no double-init), and a same-store call that arrives
 * while a different-store init is mid-flight just waits its turn.
 */
export async function ensureEngineFor(store: IfcDataStore): Promise<DuckDBIntegration> {
  return enqueue(async () => {
    // Inside our serial turn — both reads of `activeEngine` and
    // `activeStore` are stable for the duration of this task.
    if (activeEngine && activeStore === store) return activeEngine;

    if (activeEngine) {
      const prev = activeEngine;
      activeEngine = null;
      activeStore = null;
      // Block the queue on dispose so the next caller doesn't try to
      // rebuild while the previous worker is still alive. The
      // `.catch` logs but doesn't break the queue chain.
      await prev.dispose().catch((err: unknown) => {
        console.warn('[sql-state] previous DuckDB dispose failed:', err);
      });
    }

    const engine = new DuckDBIntegration();
    await engine.init(store);
    activeEngine = engine;
    activeStore = store;
    return engine;
  });
}

/** Run SQL against the engine for `store`, initialising lazily if needed. */
export async function runSql(store: IfcDataStore, sql: string): Promise<SQLResult> {
  const engine = await ensureEngineFor(store);
  return engine.query(sql);
}

/** Dispose the active engine (called on file reload / unmount). */
export async function disposeSqlEngine(): Promise<void> {
  return enqueue(async () => {
    const engine = activeEngine;
    activeEngine = null;
    activeStore = null;
    if (engine) {
      await engine.dispose().catch((err: unknown) => {
        console.warn('[sql-state] dispose failed:', err);
      });
    }
  });
}

/** Exposed for tests — resets the module-level singleton between cases. */
export function __resetSqlState(): void {
  cachedAvailable = null;
  activeEngine = null;
  activeStore = null;
  queue = Promise.resolve();
}
