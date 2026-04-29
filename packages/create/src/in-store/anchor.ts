/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spatial anchor for in-store builders — the set of references that any
 * element being added to an existing parsed model needs in order to slot
 * into the existing IFC graph correctly.
 *
 * Resolution from a parsed `IfcDataStore` lives in the backend layer
 * (where `@ifc-lite/parser` is already a dependency); the builder
 * functions in this module operate purely on these resolved ids.
 */

export type SpatialAnchorSchema = 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';

export interface SpatialAnchor {
  /** IfcOwnerHistory expressId — referenced by every IfcRoot. */
  ownerHistoryId: number;
  /** IfcGeometricRepresentationSubContext for 'Body' (or its IfcGeometricRepresentationContext fallback). */
  bodyContextId: number;
  /** The target IfcBuildingStorey expressId. */
  storeyId: number;
  /** The IfcLocalPlacement that the storey itself sits on. New element placements are chained from this. */
  storeyPlacementId: number;
  /**
   * Target schema. Builders use this to decide which optional STEP arguments
   * to emit — e.g. `IfcColumn.PredefinedType` only exists from IFC4 onward.
   * Defaults to `'IFC4'` when unset for backward compatibility.
   */
  schema?: SpatialAnchorSchema;
}
