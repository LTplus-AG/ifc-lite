/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore, IfcSourceBytes } from '@ifc-lite/parser';
import type { LocalPlacement, PropertyValue as CollabPropertyValue } from '@ifc-lite/collab';
import type { FlatSymbolic } from '@/lib/overlay-parse/symbolic-flat';

export interface RoomSymbolicSource {
  dataStore: IfcDataStore;
  source: IfcSourceBytes;
  /** Source expressIds whose paths were eligible for the room's STEP seed. */
  seededIds: ReadonlySet<number>;
  /** Portable STEP owner expressId → reconstructed room expressId. */
  ownerIds: ReadonlyMap<number, number>;
  /** Current room placements, keyed in portable STEP id space. */
  placements: ReadonlyMap<number, LocalPlacement>;
  /** Mesh-bake placements used as the origin for room move/rotation deltas. */
  baselines: ReadonlyMap<number, LocalPlacement>;
  /** Canonical CRDT property groups, separate from IFCX display projections. */
  structuredPsets: ReadonlyMap<number, Readonly<Record<string, Record<string, CollabPropertyValue>>>>;
  /** Canonical CRDT quantity groups, keyed in portable STEP id space. */
  structuredQuantities: ReadonlyMap<number, Readonly<Record<string, Record<string, number>>>>;
  /** Canonical CRDT root attributes, excluding IFCX display projections. */
  structuredAttributes: ReadonlyMap<number, Readonly<Record<string, unknown>>>;
  /** Original IFCZIP resources needed by relative IfcImageTexture URLs. */
  resources?: { modelPath?: string; resources: ReadonlyMap<string, Uint8Array> };
}

const sources = new WeakMap<object, RoomSymbolicSource>();

export function registerRoomSymbolicSource(store: IfcDataStore, source: RoomSymbolicSource): void {
  sources.set(store, source);
}

export function roomSymbolicSource(store: object): RoomSymbolicSource | undefined {
  return sources.get(store);
}

/** Re-key symbolic owners into the reconstructed room model's id space. */
export function remapRoomSymbolicOwners(flat: FlatSymbolic, ids: ReadonlyMap<number, number>): FlatSymbolic {
  const remap = (source: Uint32Array): Uint32Array => {
    const out = source.slice();
    for (let i = 0; i < out.length; i++) {
      const target = ids.get(out[i]);
      // A room deletion deliberately removes the path while the immutable
      // portable source still contains its primitive. Zero is not a valid IFC
      // express id; downstream symbolic builders drop it and retain survivors.
      out[i] = target ?? 0;
    }
    return out;
  };
  return {
    ...flat,
    polyOwner: remap(flat.polyOwner),
    circleOwner: remap(flat.circleOwner),
    textOwner: remap(flat.textOwner),
    fillOwner: remap(flat.fillOwner),
  };
}

function yaw(placement: LocalPlacement | undefined): number {
  const ref = placement?.refDirection ?? [1, 0, 0];
  return Math.atan2(ref[1], ref[0]);
}

/** Apply the same baseline-relative move/yaw used for hydrated room meshes. */
export function placeRoomSymbolic(flat: FlatSymbolic, source: RoomSymbolicSource): FlatSymbolic {
  const bounds = new Map<number, [number, number, number, number]>();
  const include = (owner: number, x: number, y: number) => {
    const b = bounds.get(owner) ?? [x, y, x, y];
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
    bounds.set(owner, b);
  };
  for (let i = 0; i < flat.polyOwner.length; i++) for (let p = flat.polyStart[i]; p < flat.polyStart[i + 1]; p += 2) include(flat.polyOwner[i], flat.polyPoints[p], flat.polyPoints[p + 1]);
  for (let i = 0; i < flat.fillOwner.length; i++) for (let p = flat.fillPointStart[i]; p < flat.fillPointStart[i + 1]; p += 2) include(flat.fillOwner[i], flat.fillPoints[p], flat.fillPoints[p + 1]);
  for (let i = 0; i < flat.circleOwner.length; i++) {
    const r = flat.circleRadius[i]; include(flat.circleOwner[i], flat.circleCenterX[i] - r, flat.circleCenterY[i] - r); include(flat.circleOwner[i], flat.circleCenterX[i] + r, flat.circleCenterY[i] + r);
  }
  for (let i = 0; i < flat.textOwner.length; i++) include(flat.textOwner[i], flat.textX[i], flat.textY[i]);
  const delta = (owner: number) => {
    const current = source.placements.get(owner);
    const baseline = source.baselines.get(owner);
    if (!current || !baseline) return null;
    return {
      x: current.location[0] - baseline.location[0],
      y: -(current.location[1] - baseline.location[1]),
      worldY: current.location[2] - baseline.location[2],
      angle: yaw(current) - yaw(baseline),
    };
  };
  const point = (owner: number, x: number, y: number): [number, number] => {
    const d = delta(owner), b = bounds.get(owner);
    if (!d || !b) return [x, y];
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    const dx = x - cx, dy = y - cy, c = Math.cos(d.angle), s = Math.sin(d.angle);
    return [cx + dx * c + dy * s + d.x, cy - dx * s + dy * c + d.y];
  };
  const points = (input: Float32Array, starts: Uint32Array, owners: Uint32Array) => {
    const out = input.slice();
    for (let i = 0; i < owners.length; i++) for (let p = starts[i]; p < starts[i + 1]; p += 2) [out[p], out[p + 1]] = point(owners[i], out[p], out[p + 1]);
    return out;
  };
  const world = (input: Float32Array, owners: Uint32Array) => {
    const out = input.slice();
    for (let i = 0; i < out.length; i++) { const d = delta(owners[i]); if (d && Number.isFinite(out[i])) out[i] += d.worldY; }
    return out;
  };
  const circleX = flat.circleCenterX.slice(), circleY = flat.circleCenterY.slice();
  const circleStart = flat.circleStartAngle.slice(), circleEnd = flat.circleEndAngle.slice();
  for (let i = 0; i < flat.circleOwner.length; i++) {
    [circleX[i], circleY[i]] = point(flat.circleOwner[i], circleX[i], circleY[i]);
    const d = delta(flat.circleOwner[i]); if (d) { circleStart[i] -= d.angle; circleEnd[i] -= d.angle; }
  }
  const textX = flat.textX.slice(), textY = flat.textY.slice(), textDirX = flat.textDirX.slice(), textDirY = flat.textDirY.slice();
  for (let i = 0; i < flat.textOwner.length; i++) {
    [textX[i], textY[i]] = point(flat.textOwner[i], textX[i], textY[i]);
    const d = delta(flat.textOwner[i]); if (d) { const c = Math.cos(d.angle), s = Math.sin(d.angle), x = textDirX[i], y = textDirY[i]; textDirX[i] = x * c + y * s; textDirY[i] = -x * s + y * c; }
  }
  return remapRoomSymbolicOwners({ ...flat,
    polyPoints: points(flat.polyPoints, flat.polyStart, flat.polyOwner), polyWorldY: world(flat.polyWorldY, flat.polyOwner),
    fillPoints: points(flat.fillPoints, flat.fillPointStart, flat.fillOwner), fillWorldY: world(flat.fillWorldY, flat.fillOwner),
    circleCenterX: circleX, circleCenterY: circleY, circleStartAngle: circleStart, circleEndAngle: circleEnd, circleWorldY: world(flat.circleWorldY, flat.circleOwner),
    textX, textY, textDirX, textDirY, textWorldY: world(flat.textWorldY, flat.textOwner),
  }, source.ownerIds);
}
