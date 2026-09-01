/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bsi::ifc::material` — the only channel IFCX carries which material an
 * element is made of. Our own reader (`packages/ifcx/src/property-extractor.ts`)
 * already unpacks this attribute into a "Material" pset (a real buildingSMART
 * PCERT sample scene authors it as `{code, uri}` on most physical elements),
 * but {@link Ifc5Exporter} never emitted it: an `IfcRelAssociatesMaterial`
 * association from the STEP source was silently dropped on export, so a
 * round trip through our own writer lost every element's material.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { extractMaterialsOnDemand } from '@ifc-lite/parser';

/**
 * Build the `bsi::ifc::material` attribute value for an entity, or
 * `undefined` when it has no material association.
 *
 * `uri` is deliberately omitted rather than fabricated: unlike an IFC class
 * name (`bsi::ifc::class`, which resolves to a real buildingSMART identifier
 * registry entry), a freeform IFC4 `IfcMaterial.Name` has no such registry —
 * inventing a resolvable-looking URI for it would misrepresent the material
 * as officially registered.
 */
export function buildMaterialAttribute(
  dataStore: IfcDataStore,
  expressId: number,
): { code: string } | undefined {
  const material = extractMaterialsOnDemand(dataStore, expressId);
  return material?.name ? { code: material.name } : undefined;
}
