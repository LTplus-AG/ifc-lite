/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { storeyPlanFrame } from '@ifc-lite/create';
import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { asExpressIdRef } from '@/lib/placement-edit';
import { AnchorEntityReader } from '../../../../../packages/create/src/in-store/resolve-anchor';
import { placementInAncestor } from '../../../../../packages/create/src/in-store/host-geometry-frame';
import { storeyPlacementChain } from '../../../../../packages/create/src/in-store/placement-frame';

/** Use the merged canonical current frame; keep unsupported 2D parent ghosts
 * explicit rather than claiming native 3D aggregate preview parity (#7298). */
export function curtainWallFrameAvailable(store: IfcDataStore, view: MutablePropertyView | undefined, storey: number): boolean {
  if (!storeyPlanFrame(store, storey, view)) return false;
  const reader = new AnchorEntityReader(store, view ?? null);
  const source = new AnchorEntityReader(store, null);
  const overlay = { readEntity: (id: number) => reader.entity(id) };
  const chain = storeyPlacementChain(store, new EntityExtractor(store.source), overlay, storey, 256);
  if (!chain) return false;
  const sourceChain = storeyPlacementChain(store, new EntityExtractor(store.source), undefined, storey, 256);
  if (!sourceChain) return false;
  const placement = asExpressIdRef(reader.entity(storey)?.attributes[5]);
  const sourcePlacement = asExpressIdRef(source.entity(storey)?.attributes[5]);
  const currentWorld = placement === null ? null : placementInAncestor(reader, placement, null);
  const savedWorld = sourcePlacement === null ? null : placementInAncestor(source, sourcePlacement, null);
  // The shared Frame change verifies current XY. Preserve the distinct native
  // elevation/RTC limitation for changed Z instead of inferring a new height.
  if (!currentWorld || !savedWorld || Math.abs(currentWorld.o[2] - savedWorld.o[2]) > 1e-8) return false;
  for (const placement of chain.keys()) {
    const record = reader.entity(placement);
    const axis = record && asExpressIdRef(record.attributes[1]);
    if (axis === null || axis === undefined || reader.entity(axis)?.type.toUpperCase() !== 'IFCAXIS2PLACEMENT3D') return false;
  }
  return true;
}
