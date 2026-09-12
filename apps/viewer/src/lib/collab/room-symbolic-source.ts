/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore, IfcSourceBytes } from '@ifc-lite/parser';
import type { FlatSymbolic } from '@/lib/overlay-parse/symbolic-flat';

export interface RoomSymbolicSource {
  dataStore: IfcDataStore;
  source: IfcSourceBytes;
  /** Source expressIds whose paths were eligible for the room's STEP seed. */
  seededIds: ReadonlySet<number>;
  /** Portable STEP owner expressId → reconstructed room expressId. */
  ownerIds: ReadonlyMap<number, number>;
}

const sources = new WeakMap<IfcDataStore, RoomSymbolicSource>();

export function registerRoomSymbolicSource(store: IfcDataStore, source: RoomSymbolicSource): void {
  sources.set(store, source);
}

export function roomSymbolicSource(store: IfcDataStore): RoomSymbolicSource | undefined {
  return sources.get(store);
}

/** Re-key symbolic owners into the reconstructed room model's id space. */
export function remapRoomSymbolicOwners(flat: FlatSymbolic, ids: ReadonlyMap<number, number>): FlatSymbolic {
  const remap = (source: Uint32Array): Uint32Array => {
    const out = source.slice();
    for (let i = 0; i < out.length; i++) {
      const target = ids.get(out[i]);
      if (target === undefined) throw new Error(`Room symbolic owner #${out[i]} has no reconstructed entity path.`);
      out[i] = target;
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
