/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The classes `base-quantities.ts` derives a base quantity set for, and the set each goes in. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';

export const WALL_TYPES = new Set(['IFCWALL', 'IFCWALLSTANDARDCASE']);
export const SLAB_TYPES = new Set(['IFCSLAB', 'IFCROOF']);
export const LINEAR_TYPES = new Set(['IFCCOLUMN', 'IFCBEAM']);

/** Every class a base quantity set is derived for, as STEP type names. */
export const BASE_QUANTITY_TYPES: readonly string[] = [...WALL_TYPES, ...SLAB_TYPES, ...LINEAR_TYPES, 'IFCDOOR', 'IFCWINDOW', 'IFCCURTAINWALL', 'IFCSTAIR'];

/** The class the export writes for `expressId`: a retype's, else the overlay's or the file's own. */
export function effectiveElementType(dataStore: IfcDataStore, view: MutablePropertyView, expressId: number): string {
  return (view.getEntityTypeMutation(expressId)?.newType ?? view.getNewEntity(expressId)?.type ?? dataStore.entities?.getTypeName(expressId) ?? '').toUpperCase();
}

/** The standard set a class's base quantities go in, or null for a class this module derives none for. */
export function baseQuantitySetName(type: string): string | null {
  if (WALL_TYPES.has(type)) return 'Qto_WallBaseQuantities';
  if (SLAB_TYPES.has(type)) return type === 'IFCROOF' ? 'Qto_RoofBaseQuantities' : 'Qto_SlabBaseQuantities';
  if (LINEAR_TYPES.has(type)) return type === 'IFCCOLUMN' ? 'Qto_ColumnBaseQuantities' : 'Qto_BeamBaseQuantities';
  if (type === 'IFCDOOR' || type === 'IFCWINDOW') return type === 'IFCDOOR' ? 'Qto_DoorBaseQuantities' : 'Qto_WindowBaseQuantities';
  if (type === 'IFCSTAIR') return 'Qto_StairBaseQuantities';
  if (type === 'IFCCURTAINWALL') return 'Qto_CurtainWallBaseQuantities';
  return null;
}
