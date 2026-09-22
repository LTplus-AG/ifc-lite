/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Element tracking: how a write node's output survives re-runs.
 *
 * Each write node owns a *tracked set*: the lane keys it produced last time
 * and the GlobalId + input digest of each. A re-run plans, per lane:
 *
 *   create   — lane is new           (GlobalId = trackingGuid(trackingKey, laneKey))
 *   update   — lane exists, digest changed
 *   keep     — lane exists, digest equal (nothing to write)
 *   remove   — lane vanished          (tombstone; the orphan Dynamo leaves behind)
 *
 * This is Rhino.Inside.Revit's "remember what each output added" made
 * explicit, keyed by the user-visible `trackingKey` instead of the node's
 * position in a file. Sets are pinned to the model state they were made
 * against (layer stack id or file hash), so a set from another model is
 * refused rather than adopted by accident.
 */

import { trackingGuid } from './digest.js';
import type { TrackingMode } from './document.js';
import type { GroupKey } from './values.js';

export interface TrackedEntry {
  readonly globalId: string;
  /** Digest of the inputs that produced this element. */
  readonly digest: string;
}

export interface TrackedSet {
  readonly trackingKey: string;
  /** Bumped on every `replace` run so fresh GlobalIds stay deterministic. */
  readonly generation: number;
  readonly entries: Readonly<Record<GroupKey, TrackedEntry>>;
  /**
   * Type of the node that made the set. Recorded so that a set whose node
   * was deleted from the graph can still be removed from the model by that
   * type's `remove` — without it the elements outlive the node that made
   * them, the orphan this whole module exists to prevent.
   */
  readonly nodeType?: string;
}

export const TRACKING_SIDECAR_VERSION = 1;

/** Shape check for a set read from storage: `load()` promises a `TrackedSet`, not whatever a hand-edited sidecar holds. */
export function isTrackedSet(value: unknown): value is TrackedSet {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.trackingKey !== 'string' || typeof v.generation !== 'number' || !Number.isInteger(v.generation)) return false;
  if (v.nodeType !== undefined && typeof v.nodeType !== 'string') return false;
  if (typeof v.entries !== 'object' || v.entries === null || Array.isArray(v.entries)) return false;
  return Object.values(v.entries as Record<string, unknown>).every(
    (e) => typeof e === 'object' && e !== null && typeof (e as TrackedEntry).globalId === 'string' && typeof (e as TrackedEntry).digest === 'string',
  );
}

/** The `sets` record of a sidecar, or undefined when any set is malformed. */
export function trackedSetsFrom(sets: unknown): Record<string, TrackedSet> | undefined {
  if (typeof sets !== 'object' || sets === null || Array.isArray(sets)) return undefined;
  const out: Record<string, TrackedSet> = {};
  for (const [key, value] of Object.entries(sets as Record<string, unknown>)) {
    if (!isTrackedSet(value) || value.trackingKey !== key) return undefined;
    out[key] = value;
  }
  return out;
}

/** `<graph>.tracking.json` */
export interface TrackingSidecar {
  readonly version: number;
  /** Layer stack id or file hash the sets were made against. */
  readonly pinnedTo: string;
  readonly sets: Readonly<Record<string, TrackedSet>>;
}

/** Where a run reads and writes tracked sets (a sidecar file, browser storage, memory). */
export interface TrackingStore {
  load(trackingKey: string): TrackedSet | undefined;
  save(set: TrackedSet): void;
  /** Every tracking key the store holds, so a run can find sets no node claims any more. */
  keys(): readonly string[];
  delete(trackingKey: string): void;
}

/** In-memory store: tests, and hosts that have not chosen a sidecar yet. */
export class MemoryTrackingStore implements TrackingStore {
  private readonly sets = new Map<string, TrackedSet>();
  load(trackingKey: string): TrackedSet | undefined {
    return this.sets.get(trackingKey);
  }
  save(set: TrackedSet): void {
    this.sets.set(set.trackingKey, set);
  }
  keys(): readonly string[] {
    return [...this.sets.keys()];
  }
  delete(trackingKey: string): void {
    this.sets.delete(trackingKey);
  }
}

export interface DesiredLane {
  readonly laneKey: GroupKey;
  readonly digest: string;
}

export interface TrackingPlan {
  readonly mode: TrackingMode;
  readonly create: readonly { laneKey: GroupKey; globalId: string }[];
  readonly update: readonly { laneKey: GroupKey; globalId: string }[];
  readonly keep: readonly { laneKey: GroupKey; globalId: string }[];
  readonly remove: readonly { laneKey: GroupKey; globalId: string }[];
  /** The set to persist after the plan is applied. */
  readonly next: TrackedSet;
  /** Lane keys that appeared more than once: only the first is tracked. */
  readonly duplicateLanes: readonly GroupKey[];
}

export function emptyTrackedSet(trackingKey: string): TrackedSet {
  return { trackingKey, generation: 0, entries: {} };
}

export function planTracking(previous: TrackedSet, desired: readonly DesiredLane[], mode: TrackingMode): TrackingPlan {
  const create: { laneKey: GroupKey; globalId: string }[] = [];
  const update: { laneKey: GroupKey; globalId: string }[] = [];
  const keep: { laneKey: GroupKey; globalId: string }[] = [];
  const remove: { laneKey: GroupKey; globalId: string }[] = [];
  const duplicateLanes: GroupKey[] = [];
  const nextEntries: Record<GroupKey, TrackedEntry> = {};

  if (mode === 'disabled') {
    return { mode, create, update, keep, remove, next: previous, duplicateLanes };
  }

  const generation = mode === 'replace' ? previous.generation + 1 : previous.generation;
  const guidKey = generation === 0 ? previous.trackingKey : `${previous.trackingKey}#${generation}`;
  const seen = new Set<GroupKey>();
  for (const lane of desired) {
    if (seen.has(lane.laneKey)) {
      duplicateLanes.push(lane.laneKey);
      continue;
    }
    seen.add(lane.laneKey);
    const prev = mode === 'update' ? previous.entries[lane.laneKey] : undefined;
    if (!prev) {
      const globalId = trackingGuid(guidKey, lane.laneKey);
      create.push({ laneKey: lane.laneKey, globalId });
      nextEntries[lane.laneKey] = { globalId, digest: lane.digest };
    } else if (prev.digest !== lane.digest) {
      update.push({ laneKey: lane.laneKey, globalId: prev.globalId });
      nextEntries[lane.laneKey] = { globalId: prev.globalId, digest: lane.digest };
    } else {
      keep.push({ laneKey: lane.laneKey, globalId: prev.globalId });
      nextEntries[lane.laneKey] = prev;
    }
  }
  // `replace` re-creates every lane under a fresh GlobalId, so every previous
  // element is removed — otherwise the old set is orphaned, not replaced.
  for (const [laneKey, entry] of Object.entries(previous.entries)) {
    if (mode === 'replace' || !seen.has(laneKey)) remove.push({ laneKey, globalId: entry.globalId });
  }
  return { mode, create, update, keep, remove, next: { trackingKey: previous.trackingKey, generation, entries: nextEntries }, duplicateLanes };
}

export class TrackingPinMismatch extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(`tracking sidecar is pinned to ${expected}, current model state is ${actual}`);
    this.name = 'TrackingPinMismatch';
  }
}

/** Read one node's set from a sidecar; refuses a sidecar pinned to another model state. */
export function trackedSetFrom(sidecar: TrackingSidecar | undefined, pinnedTo: string, trackingKey: string): TrackedSet {
  if (!sidecar) return emptyTrackedSet(trackingKey);
  if (sidecar.version !== TRACKING_SIDECAR_VERSION) throw new Error(`unsupported tracking sidecar version ${sidecar.version}`);
  if (sidecar.pinnedTo !== pinnedTo) throw new TrackingPinMismatch(sidecar.pinnedTo, pinnedTo);
  return sidecar.sets[trackingKey] ?? emptyTrackedSet(trackingKey);
}

export function withTrackedSet(sidecar: TrackingSidecar | undefined, pinnedTo: string, set: TrackedSet): TrackingSidecar {
  return {
    version: TRACKING_SIDECAR_VERSION,
    pinnedTo,
    sets: { ...(sidecar?.pinnedTo === pinnedTo ? sidecar.sets : {}), [set.trackingKey]: set },
  };
}
