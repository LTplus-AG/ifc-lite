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
  validateFlowDocument,
  type FlowDocument,
  type TrackedSet,
  type TrackingSidecar,
  type TrackingStore,
} from '@ifc-lite/flow';

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

function isSavedFlow(value: unknown): value is SavedFlow {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<SavedFlow>;
  return typeof v.updatedAt === 'number' && validateFlowDocument(v.doc).length === 0;
}

export function loadSavedFlows(): SavedFlow[] {
  try {
    const raw = localStorage.getItem(GRAPHS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as StoredFlows).flows)) return [];
    return (parsed as StoredFlows).flows.filter(isSavedFlow);
  } catch {
    return [];
  }
}

export function saveFlows(flows: readonly SavedFlow[]): void {
  const stored: StoredFlows = { schemaVersion: SCHEMA_VERSION, flows: flows.slice(0, MAX_GRAPHS) };
  localStorage.setItem(GRAPHS_KEY, JSON.stringify(stored));
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
    } catch {
      return undefined;
    }
  }

  static clear(graphId: string): void {
    localStorage.removeItem(TRACKING_PREFIX + graphId);
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
