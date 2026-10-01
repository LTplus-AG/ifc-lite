/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saved flow graphs and their tracking sidecars in `localStorage`.
 *
 * A graph is the same `*.flow.json` document the CLI runs — export and
 * import move the JSON unchanged, so a graph edited here runs in CI. The
 * tracked element sets of a graph are stored separately under the graph
 * id, pinned to the model's content hash: a graph is reusable across
 * models, its element sets are not (see `@ifc-lite/flow` tracking).
 */

import {
  FLOW_VERSION,
  TRACKING_SIDECAR_VERSION,
  trackedSetsFrom,
  migrateFlowDocument,
  validateFlowDocument,
  type FlowDocument,
  type TrackedSet,
  type TrackingSidecar,
  type TrackingStore,
} from '@ifc-lite/flow';

import { optionalLocalStorage, preserveUnreadableEntry, type UnreadableEntryStorage } from '../storage/unreadable-entry';

const GRAPHS_KEY = 'ifc-lite-flows';
const TRACKING_PREFIX = 'ifc-lite-flow-tracking:';
const SCHEMA_VERSION = 1;
const MAX_GRAPHS = 200;
const MAX_GRAPH_BYTES = 500_000;

export interface SavedFlow {
  readonly doc: FlowDocument;
  readonly updatedAt: number;
}

interface StoredFlows {
  schemaVersion: number;
  flows: SavedFlow[];
}

function readFlows(storage: UnreadableEntryStorage): { flows: SavedFlow[]; writable: boolean } {
  const raw = storage.getItem(GRAPHS_KEY);
  if (!raw) return { flows: [], writable: true };
  const flows: SavedFlow[] = [];
  const ids = new Set<string>();
  let damaged = false;
  let cause: unknown;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || (parsed as StoredFlows).schemaVersion !== SCHEMA_VERSION || !Array.isArray((parsed as StoredFlows).flows)) {
      throw new Error('Invalid saved workflow library');
    }
    for (const entry of (parsed as StoredFlows).flows) {
      const migrated = migrateFlowDocument(entry?.doc);
      if (!entry || typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)
        || validateFlowDocument(migrated).length || flows.length >= MAX_GRAPHS) {
        damaged = true; continue;
      }
      const doc = migrated as FlowDocument;
      if (ids.has(doc.id) || !isFlowWithinSizeLimit(doc)) { damaged = true; continue; }
      ids.add(doc.id); flows.push({ doc, updatedAt: entry.updatedAt });
    }
  } catch (error) { damaged = true; cause = error; }
  if (!damaged) return { flows, writable: true };
  const writable = preserveUnreadableEntry(storage, GRAPHS_KEY, cause ?? new Error('Invalid or duplicate saved workflows'));
  if (writable) {
    try { storage.setItem(GRAPHS_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION, flows })); }
    catch (error) { console.warn('[Flow] Recovered workflows remain in memory; storage refused the repair', error); }
  }
  return { flows, writable };
}

export function loadSavedFlows(): SavedFlow[] {
  try {
    const storage = optionalLocalStorage();
    if (!storage) { console.warn('[Flow] Saved workflows are unavailable because browser storage is disabled'); return []; }
    return readFlows(storage).flows;
  } catch (error) { console.warn('[Flow] Failed to read saved workflows', error); return []; }
}

/** The caller retains its in-memory library when browser storage refuses a write. */
export function saveFlows(flows: readonly SavedFlow[]): boolean {
  try {
    const storage = optionalLocalStorage();
    if (!storage) throw new Error('Browser storage is unavailable');
    if (!readFlows(storage).writable) throw new Error('The damaged workflow library could not be preserved');
    const stored: StoredFlows = { schemaVersion: SCHEMA_VERSION, flows: flows.slice(0, MAX_GRAPHS) };
    storage.setItem(GRAPHS_KEY, JSON.stringify(stored));
    return true;
  } catch (error) { console.warn('[Flow] Workflows remain in memory; failed to save the library', error); return false; }
}

export function isFlowWithinSizeLimit(doc: FlowDocument): boolean {
  return JSON.stringify(doc).length <= MAX_GRAPH_BYTES;
}

export function canCreateFlow(count: number): boolean {
  return count < MAX_GRAPHS;
}

/** A fresh, empty graph. */
export function newFlowDocument(name: string): FlowDocument {
  return { flowVersion: FLOW_VERSION, id: crypto.randomUUID(), name, capabilities: [], inputs: [], outputs: [], nodes: [], edges: [] };
}

/** Serialize for export: the same bytes `ifc-lite flow run` reads. */
export function flowToJson(doc: FlowDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Tracked sets for one graph, pinned to the model they were made against. */
export class BrowserTrackingStore implements TrackingStore {
  private sets: Record<string, TrackedSet>;
  /**
   * Set when a write to storage failed (disabled, quota): the in-memory
   * sets are then ahead of what the next session will read, so the runner
   * reports the run as not durable instead of treating tracking as saved.
   */
  persistError: string | undefined;

  constructor(private readonly graphId: string, private readonly pinnedTo: string) {
    this.sets = {};
    const sidecar = BrowserTrackingStore.read(graphId);
    // Sets from another model state are not adopted: a graph re-run on a
    // different model must start from an empty set (the CLI warns instead,
    // because headless runs chain output files).
    if (sidecar && sidecar.pinnedTo === pinnedTo) this.sets = { ...sidecar.sets };
  }

  static read(graphId: string): TrackingSidecar | undefined {
    try {
      const raw = localStorage.getItem(TRACKING_PREFIX + graphId);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Partial<TrackingSidecar>;
      if (parsed.version !== TRACKING_SIDECAR_VERSION || typeof parsed.pinnedTo !== 'string') return undefined;
      // Every set is shape-checked, not just the container: `load()` promises
      // a `TrackedSet`, and a hand-edited value would reach the scheduler as one.
      const sets = trackedSetsFrom(parsed.sets);
      return sets ? { version: parsed.version, pinnedTo: parsed.pinnedTo, sets } : undefined;
    } catch (error) {
      console.warn('[Flow] Failed to read tracking sidecar', error);
      return undefined;
    }
  }

  static clear(graphId: string): void {
    localStorage.removeItem(TRACKING_PREFIX + graphId);
  }

  /** Clear every graph's sidecar whose id starts with `idPrefix`. */
  static clearByIdPrefix(idPrefix: string): void {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(TRACKING_PREFIX + idPrefix)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  }

  load(trackingKey: string): TrackedSet | undefined {
    return this.sets[trackingKey];
  }

  save(set: TrackedSet): void {
    this.sets[set.trackingKey] = set;
    this.write();
  }

  keys(): readonly string[] {
    return Object.keys(this.sets);
  }

  delete(trackingKey: string): void {
    if (!(trackingKey in this.sets)) return;
    delete this.sets[trackingKey];
    this.write();
  }

  private write(): void {
    const sidecar: TrackingSidecar = { version: TRACKING_SIDECAR_VERSION, pinnedTo: this.pinnedTo, sets: this.sets };
    try {
      localStorage.setItem(TRACKING_PREFIX + this.graphId, JSON.stringify(sidecar));
      this.persistError = undefined;
    } catch (err) {
      this.persistError = err instanceof Error ? err.message : String(err);
    }
  }
}
