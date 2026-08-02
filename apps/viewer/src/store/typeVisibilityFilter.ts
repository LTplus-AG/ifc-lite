/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Single source of truth for the IFC-class → `typeVisibility` toggle mapping.
 *
 * The same mapping was previously copy-pasted into three places
 * (`ViewportContainer.tsx` mesh filter, `basketVisibleSet.ts` visible-set
 * resolution, and `GLBExportDialog.tsx` export gating). Keeping it in one
 * table means a new class → toggle association is added once and every
 * consumer (viewport, Cesium, basket, export) stays in lockstep.
 */

import type { TypeVisibility } from './types.js';

/** Which `typeVisibility` boolean gates each IFC class. */
type TypeVisibilityKey = keyof Pick<
  TypeVisibility,
  'spaces' | 'spatialZones' | 'openings' | 'virtualElements' | 'site' | 'ifcAnnotations'
>;

/**
 * IFC class → toggle key. When the mapped toggle is `false` the class is
 * hidden from the viewport / export.
 *
 * `IfcGeographicElement` (terrain, `.TERRAIN.` etc.) rides the `site` toggle:
 * the Site row is labelled "Terrain & context" and users reasonably expect
 * modelled terrain to disappear with it (issue #1480). It renders as a normal
 * product mesh, so — like `IfcSite` — it is otherwise unaffected by any
 * type-visibility control.
 */
const IFC_TYPE_TO_VISIBILITY_KEY: Readonly<Record<string, TypeVisibilityKey>> = {
  IfcSpace: 'spaces',
  IfcSpatialZone: 'spatialZones',
  IfcOpeningElement: 'openings',
  IfcVirtualElement: 'virtualElements',
  IfcSite: 'site',
  IfcGeographicElement: 'site',
  // IfcAnnotation can carry real 3D solid geometry (Bonsai plan-view boxes,
  // Revit "Model Text" breps) on top of the 2D symbolic curve overlay; the
  // `ifcAnnotations` toggle hides both (issues #1354, #1480).
  IfcAnnotation: 'ifcAnnotations',
};

/**
 * True when a mesh of `ifcType` should be visible under the current
 * `typeVisibility` toggles. Classes with no mapped toggle are always visible.
 */
export function isTypeVisible(
  ifcType: string | undefined,
  typeVisibility: Pick<TypeVisibility, TypeVisibilityKey>,
): boolean {
  if (!ifcType) return true;
  const key = IFC_TYPE_TO_VISIBILITY_KEY[ifcType];
  if (key === undefined) return true;
  return typeVisibility[key];
}

/**
 * Build the set of IFC class names that are currently hidden by the toggles —
 * used by the GLB exporter to drop them on a visible-only export so the file
 * matches the viewport.
 */
export function buildHiddenIfcTypes(
  typeVisibility: Pick<TypeVisibility, TypeVisibilityKey>,
): Set<string> {
  const out = new Set<string>();
  for (const [ifcType, key] of Object.entries(IFC_TYPE_TO_VISIBILITY_KEY)) {
    if (!typeVisibility[key]) out.add(ifcType);
  }
  return out;
}
