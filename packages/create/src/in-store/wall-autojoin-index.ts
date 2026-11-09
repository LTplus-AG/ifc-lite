/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { AnchorEntityReader } from './resolve-anchor.js';
import { safeLengthUnitScale } from './length-unit-scale.js';
import { readWallJoinEndpoints, type WallEndpoints, type WallJoinRead } from './wall-join-read.js';

const TOLERANCE = 1e-6;
const cell = (n: number) => Math.round(n / TOLERANCE);
const key = (parent: number | null, z: number, x: number, y: number) => `${parent}:${z}:${x}:${y}`;

/** A transaction-local endpoint lookup. Updates publish only after its owning
 * ordinary-creation transaction (including host history/publication) commits. */
export interface WallAutojoinIndex {
  candidates(wall: WallJoinRead): readonly number[];
  remember(wall: WallJoinRead): void;
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

const summary = (wall: WallJoinRead): WallEndpoints => ({ wallId: wall.wallId, parentPlacementId: wall.parentPlacementId,
  elevation: wall.location[2], start: wall.wall.start, end: wall.wall.end });
const sessions = new WeakMap<MutablePropertyView, { store: IfcDataStore; source: IfcDataStore['source']; sourceCount: number; revision: number; endpoints: Endpoints }>();

/** Run ordinary wall creation at the COMMITTED view boundary, outside draft
 * wrappers. Each successful addition updates the index in O(1); any other
 * edit, Undo, Redo, or source swap invalidates it via the live revision.
 * Do not wrap arbitrary geometry edits: those must invalidate this cache. */
export function withWallAutojoinIndex<T>(store: IfcDataStore, view: MutablePropertyView, edit: (index: WallAutojoinIndex) => T): T {
  let session = sessions.get(view);
  if (!session || session.store !== store || session.source !== store.source || session.sourceCount !== store.entityIndex.byId.size
    || session.revision !== view.getMutationRevision()) {
    const endpoints = new Endpoints();
    const reader = new AnchorEntityReader(store, view);
    const scale = store.source.byteLength ? safeLengthUnitScale(store.source, store.entityIndex, 'wall-autojoin') ?? 1 : 1;
    for (const type of ['IFCWALL', 'IFCWALLSTANDARDCASE']) for (const id of reader.ids(type)) {
      try {
        const wall = readWallJoinEndpoints(store, view, id, scale);
        if (wall) endpoints.add(wall);
      } catch (error) {
        console.warn(`[wall-autojoin] Cannot index wall #${id}`, error);
      }
    }
    session = { store, source: store.source, sourceCount: store.entityIndex.byId.size, revision: view.getMutationRevision(), endpoints };
    sessions.set(view, session);
  }
  const pending = new Map<number, WallEndpoints>();
  const staged = new Endpoints();
  const current = session;
  try {
    const result = edit({
      candidates: wall => [...new Set([...current.endpoints.candidates(summary(wall)), ...staged.candidates(summary(wall))])],
      remember: wall => { const row = summary(wall); pending.set(wall.wallId, row); staged.add(row); },
    });
    for (const row of pending.values()) current.endpoints.add(row);
    current.revision = view.getMutationRevision();
    return result;
  } catch (error) {
    // Publication/rollback can change the revision without a surviving wall.
    sessions.delete(view);
    throw error;
  }
}
