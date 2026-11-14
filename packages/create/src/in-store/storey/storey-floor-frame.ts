/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { placementInAncestor } from '../host-geometry-frame.js';
import type { StoreyInventory, StoreyRecord } from './storey-model.js';

const floors = new WeakMap<StoreyInventory, Map<number, number>>();

/** Physical world Z in metres. Elevation is the fallback for an unplaced floor. */
export function storeyFloorWorld(inventory: StoreyInventory, storey: StoreyRecord): number {
  let known = floors.get(inventory);
  if (!known) { known = new Map(); floors.set(inventory, known); }
  const saved = known.get(storey.expressId);
  if (saved !== undefined) return saved;
  const frame = storey.placementId === null ? null : placementInAncestor(inventory.reader, storey.placementId, null);
  const world = frame ? frame.o[2] * inventory.scale : storey.elevation;
  known.set(storey.expressId, world);
  return world;
}
