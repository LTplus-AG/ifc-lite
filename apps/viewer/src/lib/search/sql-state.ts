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
let initInFlight: Promise<DuckDBIntegration> | null = null;

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
 */
export async function ensureEngineFor(store: IfcDataStore): Promise<DuckDBIntegration> {
  if (activeEngine && activeStore === store) return activeEngine;

  if (initInFlight) {
    // An init is already running for some store — wait for it and decide
    // afterwards whether the returned engine matches ours.
    const prev = await initInFlight;
    if (activeStore === store) return prev;
  }

  // Different store (model swap) or first init — tear down + rebuild.
  if (activeEngine) {
    const prev = activeEngine;
    activeEngine = null;
    activeStore = null;
    // Dispose best-effort in the background; don't block the new init.
    void prev.dispose().catch((err: unknown) => {
      console.warn('[sql-state] previous DuckDB dispose failed:', err);
    });
  }

  initInFlight = (async () => {
    const engine = new DuckDBIntegration();
    await engine.init(store);
    activeEngine = engine;
    activeStore = store;
    return engine;
  })();

  try {
    return await initInFlight;
  } finally {
    initInFlight = null;
  }
}

/** Run SQL against the engine for `store`, initialising lazily if needed. */
export async function runSql(store: IfcDataStore, sql: string): Promise<SQLResult> {
  const engine = await ensureEngineFor(store);
  return engine.query(sql);
}

/** Dispose the active engine (called on file reload / unmount). */
export async function disposeSqlEngine(): Promise<void> {
  const engine = activeEngine;
  activeEngine = null;
  activeStore = null;
  initInFlight = null;
  if (engine) {
    await engine.dispose().catch((err: unknown) => {
      console.warn('[sql-state] dispose failed:', err);
    });
  }
}

/** Exposed for tests — resets the module-level singleton between cases. */
export function __resetSqlState(): void {
  cachedAvailable = null;
  activeEngine = null;
  activeStore = null;
  initInFlight = null;
}
