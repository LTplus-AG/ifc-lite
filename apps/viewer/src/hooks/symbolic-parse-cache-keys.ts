/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { createElementFieldReader } from '@/lib/charts/element-field-reader';
import { effectiveScheduleGroups } from '@/lib/effective-spatial-groups';
import type { OverlayRtcContext } from '../lib/overlay-parse/rtc-context.js';

/** Stable value key for the live lookups used by buildParseResult's buckets. */
export function spatialBucketKey(
  elementToStorey: ReadonlyMap<number, number> | undefined,
  storeyElevations: ReadonlyMap<number, number> | undefined,
): string {
  // Keep cache keys bounded even for large models. This mirrors the source's
  // contentKey contract: a stable 64-bit digest of every lookup pair.
  let hash = 0xcbf29ce484222325n;
  const feed = (value: string): void => {
    for (let i = 0; i < value.length; i++) {
      hash ^= BigInt(value.charCodeAt(i));
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
  };
  const pairs = (map: ReadonlyMap<number, number> | undefined): void => {
    if (!map) { feed('-;'); return; }
    // Sort so equivalent maps produce the same key independent of insertion
    // order. Delimiters make the two maps and numeric pairs unambiguous.
    for (const [id, value] of [...map].sort(([a], [b]) => a - b)) feed(`${id}:${value},`);
    feed(';');
  };
  pairs(elementToStorey);
  pairs(storeyElevations);
  return hash.toString(16).padStart(16, '0');
}

export function sourceFlatKey(
  store: IfcDataStore,
  rtc: Exclude<OverlayRtcContext, { mode: 'pending' }>,
): string | null {
  const source = store.source;
  return source?.contentKey ? `${source.contentKey}|${rtc.key}` : null;
}

export interface SpatialBucketSnapshot {
  elementToStorey?: ReadonlyMap<number, number>;
  storeyElevations?: ReadonlyMap<number, number>;
  deletedOwners?: ReadonlySet<number>;
  key: string;
}

let SPATIAL_SNAPSHOTS = new WeakMap<IfcDataStore, {
  elementToStoreyRef: ReadonlyMap<number, number> | undefined;
  storeyElevationsRef: ReadonlyMap<number, number> | undefined;
  mutationVersion: number;
  view: MutablePropertyView | undefined;
  snapshot: SpatialBucketSnapshot;
}>();
let VIEW_IDS = new WeakMap<MutablePropertyView, number>();
let nextViewId = 1;

/**
 * Copy and digest live bucket lookups once per map identity / mutationVersion.
 * Hook renders call this from getParseFor, so a render only does O(1) work;
 * in-place authored hierarchy edits bump mutationVersion and refresh the copy.
 */
export function spatialBucketSnapshotFor(
  store: IfcDataStore,
  mutationVersion: number,
  view?: MutablePropertyView,
): SpatialBucketSnapshot {
  // @raw-entity-enumeration-ok immutable source hierarchy snapshot; live viewers supply the effective schedule graph below
  const elementToStoreyRef = store.spatialHierarchy?.elementToStorey;
  const storeyElevationsRef = store.spatialHierarchy?.storeyElevations;
  const cached = SPATIAL_SNAPSHOTS.get(store);
  if (cached && cached.elementToStoreyRef === elementToStoreyRef
    && cached.storeyElevationsRef === storeyElevationsRef
    && cached.mutationVersion === mutationVersion && cached.view === view) return cached.snapshot;

  // Source hierarchy maps are authoritative until a mutation overlay exists.
  // When it does, rebuild the bucket lookups from the effective relationship
  // graph once per mutation revision. This reflects retargeted/deleted edges
  // and newly authored storeys without scanning the graph for every owner.
  let elementToStorey = elementToStoreyRef ? new Map(elementToStoreyRef) : undefined;
  let storeyElevations = storeyElevationsRef ? new Map(storeyElevationsRef) : undefined;
  if (view?.hasPendingChanges()) {
    const groups = effectiveScheduleGroups(store, view, 'IfcBuildingStorey');
    elementToStorey = new Map();
    storeyElevations = new Map();
    const reader = createElementFieldReader(store, view);
    const scale = store.lengthUnitScale ?? 1;
    for (const [storeyId, owners] of groups) {
      for (const ownerId of owners) elementToStorey.set(ownerId, storeyId);
      const value = reader.read(storeyId, { kind: 'attribute', attributeName: 'Elevation', valueKind: 'number' });
      const elevation = typeof value === 'number' ? value * scale : store.spatialHierarchy?.storeyElevations.get(storeyId);
      if (elevation !== undefined && Number.isFinite(elevation)) storeyElevations.set(storeyId, elevation);
    }
  }
  const deletedOwners = view?.hasPendingChanges() ? new Set(view.getTombstones()) : undefined;
  const viewId = view && view.hasPendingChanges()
    ? (VIEW_IDS.get(view) ?? (VIEW_IDS.set(view, nextViewId), nextViewId++))
    : 0;
  const key = `${spatialBucketKey(elementToStorey, storeyElevations)}|overlay:${viewId}:${viewId ? mutationVersion : 0}`;
  const snapshot = { elementToStorey, storeyElevations, deletedOwners, key };
  SPATIAL_SNAPSHOTS.set(store, {
    elementToStoreyRef, storeyElevationsRef, mutationVersion, view, snapshot,
  });
  return snapshot;
}

export function resetSpatialBucketSnapshotsForTests(): void {
  SPATIAL_SNAPSHOTS = new WeakMap();
  VIEW_IDS = new WeakMap();
  nextViewId = 1;
}
