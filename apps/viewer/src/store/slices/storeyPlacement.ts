/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';

/**
 * IfcBuildingStorey.ObjectPlacement is optional in the schema —
 * some authoring tools leave it null when the file was never
 * meant to host geometry. Authoring actions need a placement to
 * anchor their new entities against, so we materialise a default
 * IfcLocalPlacement at the storey's elevation when one's missing
 * and patch the storey's attribute via the overlay.
 *
 * Idempotent: if the storey already has a placement (number or
 * `#X` string ref), this is a no-op. Returns true when a
 * placement was created.
 */
export function ensureStoreyPlacement(
  dataStore: IfcDataStore,
  editor: StoreEditor,
  storeyExpressId: number,
): boolean {
  if (!editor.hasEntity(storeyExpressId)) return false;
  const overlay = editor.getNewEntity(storeyExpressId);
  let attrs: unknown[];
  if (overlay) {
    attrs = overlay.attributes.slice();
  } else {
    // @raw-entity-enumeration-ok Source byte span supplies attributes for a live storey; the positional overlay is checked below.
    const ref = dataStore.entityIndex.byId.get(storeyExpressId);
    if (!ref) return false;
    const extractor = new EntityExtractor(dataStore.source);
    const entity = extractor.extractEntity(ref);
    if (!entity) return false;
    attrs = entity.attributes.slice();
  }

  // IfcProduct.ObjectPlacement is at index 5 across IFC2X3 / IFC4.
  const positional = editor.getMutationView().getPositionalMutationsForEntity(storeyExpressId);
  const existing = positional?.has(5) ? positional.get(5) : attrs[5];
  if (typeof existing === 'number' && Number.isFinite(existing)) return false;
  if (typeof existing === 'string' && existing.startsWith('#')) return false;

  // Build a fresh placement at world origin. The storey's elevation
  // (if any) carries through the geometry pipeline elsewhere; this
  // placement gives the IFC graph what resolveSpatialAnchor needs.
  const elevation = dataStore.spatialHierarchy?.storeyElevations?.get(storeyExpressId) ?? 0;
  const originPt = editor.addEntity('IfcCartesianPoint', [[0, 0, elevation]]).expressId;
  const axisPlacement = editor.addEntity('IfcAxis2Placement3D', [`#${originPt}`, null, null]).expressId;
  const localPlacement = editor.addEntity('IfcLocalPlacement', [null, `#${axisPlacement}`]).expressId;

  editor.setPositionalAttribute(storeyExpressId, 5, `#${localPlacement}`);
  return true;
}
