/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { storeyPlanFrame } from '@ifc-lite/create';
import { EntityExtractor, effectiveMetadataRecord, getAttributeNamesForSchema, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { asExpressIdRef } from '@/lib/placement-edit';
import { storeyPlacementChain } from '../../../../../packages/create/src/in-store/placement-frame';

/** The command ghost uses the immutable source plan. A changed placement
 * dependency must be explicitly unavailable until that shared reader supports
 * the current overlay; never approximate its transform here (#7298). */
export function curtainWallSourceFrameAvailable(store: IfcDataStore, view: MutablePropertyView | undefined, storey: number): boolean {
  if (!storeyPlanFrame(store, storey)) return false;
  const chain = storeyPlacementChain(store, new EntityExtractor(store.source), undefined, storey);
  if (chain && chain.size > 256) return false;
  const same = (id: number, names: readonly string[]): boolean => {
    const source = effectiveMetadataRecord(store, id), current = effectiveMetadataRecord(store, id, view);
    if (!source || !current || source.type !== current.type) return false;
    const attributes = getAttributeNamesForSchema(source.type, store.schemaVersion);
    return names.every(name => {
      const index = attributes.indexOf(name);
      if (index < 0) return false;
      // Canonical reference reader accepts source numeric and authored '#id' forms.
      if (['ObjectPlacement', 'PlacementRelTo', 'RelativePlacement', 'Location', 'Axis', 'RefDirection'].includes(name)) {
        return asExpressIdRef(source.attributes[index]) === asExpressIdRef(current.attributes[index]);
      }
      return JSON.stringify(source.attributes[index]) === JSON.stringify(current.attributes[index]);
    });
  };
  if (!same(storey, ['ObjectPlacement', 'Elevation'])) return false;
  for (const placement of chain?.keys() ?? []) {
    if (!same(placement, ['PlacementRelTo', 'RelativePlacement'])) return false;
    const source = effectiveMetadataRecord(store, placement);
    const axis = source && asExpressIdRef(source.attributes[1]);
    if (axis === null || axis === undefined) return false;
    const axes = effectiveMetadataRecord(store, axis);
    // Native curtain products use 3D placements; a 2D ancestor has no verified matching command ghost.
    if (!axes || axes.type.toUpperCase() !== 'IFCAXIS2PLACEMENT3D' || !same(axis, ['Location', 'Axis', 'RefDirection'])) return false;
    const point = asExpressIdRef(axes.attributes[0]);
    if (point === null || !same(point, ['Coordinates'])) return false;
    for (const direction of axes.attributes.slice(1, 3)) {
      const id = asExpressIdRef(direction);
      if (id !== null && !same(id, ['DirectionRatios'])) return false;
    }
  }
  return true;
}
