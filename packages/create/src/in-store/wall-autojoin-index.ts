/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { createSchemaEntityNameSnapshot, type IfcDataStore } from '@ifc-lite/parser';
import { AnchorEntityReader } from './resolve-anchor.js';
import { safeLengthUnitScale } from './length-unit-scale.js';
import { readWallJoinEndpoints, type WallEndpoints } from './wall-join-read.js';
import { schemaRegistry } from './schema-attributes.js';

const TOLERANCE = 1e-6;
const cell = (n: number) => Math.round(n / TOLERANCE);
const key = (parent: number | null, z: number, x: number, y: number) => `${parent}:${z}:${x}:${y}`;

/** A transaction-local endpoint lookup. Updates publish only after its owning
 * ordinary-creation transaction (including host history/publication) commits. */
export interface WallAutojoinIndex {
  candidates(wall: WallEndpoints): readonly number[];
  remember(wall: WallEndpoints): void;
}

class Endpoints {
  private readonly buckets = new Map<string, Set<number>>();
  private readonly order = new Map<number, number>();

  add(wall: WallEndpoints): void {
    if (!this.order.has(wall.wallId)) this.order.set(wall.wallId, this.order.size);
    for (const p of [wall.start, wall.end]) {
      const k = key(wall.parentPlacementId, cell(wall.elevation), cell(p[0]), cell(p[1]));
      let bucket = this.buckets.get(k);
      if (!bucket) this.buckets.set(k, bucket = new Set());
      bucket.add(wall.wallId);
    }
  }

  candidates(wall: WallEndpoints): number[] {
    if (this.order.size === 0) return [];
    const found = new Set<number>();
    // Search neighbouring rounded cells too: coincident points can straddle a
    // rounding boundary, including elevation. The exact test remains in join.
    for (const p of [wall.start, wall.end]) for (const dz of [-1, 0, 1]) {
      for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
        for (const id of this.buckets.get(key(wall.parentPlacementId, cell(wall.elevation) + dz, cell(p[0]) + dx, cell(p[1]) + dy)) ?? []) found.add(id);
      }
    }
    return [...found].sort((a, b) => this.order.get(a)! - this.order.get(b)!);
  }
}

interface Session {
  store: IfcDataStore; source: IfcDataStore['source']; schema: IfcDataStore['schemaVersion'];
  sourceCount: number; revision: number; endpoints: Endpoints; scale: number; skipped: boolean;
}
const sessions = new WeakMap<MutablePropertyView, Session>();

function prepareIndex(store: IfcDataStore, view: MutablePropertyView): Session {
  const schema = store.schemaVersion;
  if (schema !== undefined && schema !== 'IFC2X3' && schema !== 'IFC4' && schema !== 'IFC4X3') {
    throw new Error(`Automatic wall joins are unavailable for schema ${schema}`);
  }
  let session = sessions.get(view);
  // @raw-entity-enumeration-ok Source count only invalidates the cache; reader.ids merges source/overlay membership, and view revision tracks session edits and tombstones.
  const sourceCount = store.entityIndex.byId.size;
  if (!session || session.store !== store || session.source !== store.source || session.schema !== schema || session.sourceCount !== sourceCount
    || session.revision !== view.getMutationRevision()) {
    const endpoints = new Endpoints();
    // One finite read: avoid enumerating/serializing the complete schema key
    // list for every placement, representation and axis point of every wall.
    const names = schema === 'IFC2X3' || schema === 'IFC4' || schema === 'IFC4X3'
      ? createSchemaEntityNameSnapshot(schemaRegistry(schema, 'wall-autojoin')) : undefined;
    const reader = new AnchorEntityReader(store, view, names);
    const scale = store.source.byteLength ? safeLengthUnitScale(store.source, store.entityIndex, 'wall-autojoin') ?? 1 : 1;
    let skipped = false;
    for (const type of ['IFCWALL', 'IFCWALLSTANDARDCASE']) for (const id of reader.ids(type)) {
      try {
        const wall = readWallJoinEndpoints(store, view, id, scale, reader);
        if (wall) endpoints.add(wall);
        else skipped = true;
      } catch (error) {
        throw new Error(`Cannot index wall #${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    session = { store, source: store.source, schema, sourceCount, revision: view.getMutationRevision(), endpoints, scale, skipped };
    sessions.set(view, session);
  }
  return session;
}

/** Maintain endpoints as public raw creation appends complete wall records.
 * Appending a new record cannot change an already readable wall. Incomplete
 * forward references or any intervening edit discard the cache instead.
 * The append itself retains its errors and never depends on indexing success. */
export function withWallAutojoinAppend<T extends { expressId: number }>(
  store: IfcDataStore, view: MutablePropertyView, type: string, append: () => T,
): T {
  let session = sessions.get(view);
  const revision = view.getMutationRevision();
  const result = append();
  if (store.schemaVersion !== undefined && !['IFC2X3', 'IFC4', 'IFC4X3'].includes(store.schemaVersion)) {
    sessions.delete(view);
    return result;
  }
  try {
    const wall = ['IFCWALL', 'IFCWALLSTANDARDCASE'].includes(type.trim().toUpperCase());
    if (!session || session.revision !== revision || session.store !== store || session.source !== store.source || session.schema !== store.schemaVersion) {
      sessions.delete(view);
      if (!wall) return result;
      session = prepareIndex(store, view);
    } else if (wall) {
      const endpoints = readWallJoinEndpoints(store, view, result.expressId, session.scale);
      if (!endpoints) { sessions.delete(view); return result; }
      session.endpoints.add(endpoints);
    }
    if (session.skipped) sessions.delete(view);
    else session.revision = view.getMutationRevision();
  } catch (error) {
    sessions.delete(view);
    console.warn(`[ifc-lite/create] Wall endpoint index update skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

/** Run ordinary wall creation at the COMMITTED view boundary, outside draft
 * wrappers. Each successful addition updates the index in O(1); any other
 * edit, Undo, Redo, or source swap invalidates it via the live revision.
 * Do not wrap arbitrary geometry edits: those must invalidate this cache. */
export function withWallAutojoinIndex<T>(store: IfcDataStore, view: MutablePropertyView, edit: (index: WallAutojoinIndex) => T): T {
  let current: Session;
  try {
    current = prepareIndex(store, view);
  } catch (error) {
    sessions.delete(view);
    // Carry setup failure into ordinary creation's join-only catch. The host
    // callback still runs once, and its permission/publication errors escape.
    const unavailable = (): never => { throw error; };
    return edit({ candidates: unavailable, remember: unavailable });
  }
  const pending = new Map<number, WallEndpoints>();
  const staged = new Endpoints();
  try {
    const result = edit({
      candidates: wall => [...new Set([...current.endpoints.candidates(wall), ...staged.candidates(wall)])],
      remember: wall => { pending.set(wall.wallId, wall); staged.add(wall); },
    });
    if (pending.size) {
      for (const row of pending.values()) current.endpoints.add(row);
      current.revision = view.getMutationRevision();
    } else sessions.delete(view); // A failed initial join read left no endpoint for the surviving wall.
    return result;
  } catch (error) {
    // Publication/rollback can change the revision without a surviving wall.
    sessions.delete(view);
    throw error;
  }
}
