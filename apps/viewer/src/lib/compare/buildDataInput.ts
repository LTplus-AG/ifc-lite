/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The data half of a compare fingerprint: one entity's canonical
 * {@link DataFingerprintInput}, assembled from the store's on-demand
 * extractors. Split out of `buildFingerprints.ts` for size; that module still
 * owns the mesh/box/volume/key assembly around it.
 */

import type { DataFingerprintInput } from '@ifc-lite/diff';
import { RelationshipType } from '@ifc-lite/data';
import {
  extractAllEntityAttributes,
  extractAllMaterialsOnDemand,
  extractClassificationsOnDemand,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  quantitySiScale,
  roundToScale,
  scaledPropertyValue,
  type IfcDataStore,
  type ProjectUnits,
} from '@ifc-lite/parser';
import { classificationLabel } from '../lens-classification-labels.js';
import { lensMaterialNames } from '@ifc-lite/rules';
import { isGeometricDataName } from './geometricData.js';
import { isTypeObjectClass, typeObjectTag } from './typeObjectTag.js';
import type { ExtractedPropertySets } from './authoredKeys.js';

/**
 * Assemble the canonical {@link DataFingerprintInput} for one entity from the
 * store's on-demand extractors. Mirrors the extraction in
 * `examples/threejs-viewer/src/compare.ts`; `@ifc-lite/diff` does the sorting
 * + hashing so base and head produce byte-identical hashes for an unchanged
 * entity.
 */
export function buildDataInput(
  store: IfcDataStore,
  localId: number,
  ifcType: string,
  units: ProjectUnits, // scales Qto_ quantities and measure properties to base SI
  preExtractedPropertySets?: ExtractedPropertySets,
): DataFingerprintInput {
  const predefinedType = extractAllEntityAttributes(store, localId).find(
    (attribute) => attribute.name === 'PredefinedType',
  )?.value;
  // `Tag`, and only for a TYPE OBJECT (issue #2021). Type objects reach this
  // adapter because the wasm pass emits type geometry too (#957/#994 —
  // geometryClass 1 orphan, 2 instanced type library), and they are exactly the
  // entities the data hash cannot separate on its own: same name, same class,
  // no occurrence attributes, differing only in `Tag`. On an OCCURRENCE it stays
  // out, because there it is the authoring tool's element id rather than design
  // content and `dataHash` is the content bucket key; see
  // `DataFingerprintInput.tag`.
  const tag = isTypeObjectClass(ifcType)
    ? typeObjectTag(store, localId, ifcType)
    : undefined;

  // Data vs geometry: placement/coordinate data (elevation, level offsets, …)
  // is owned by the geometry hash, so strip it from the data fingerprint — a
  // pure move must read as a geometry change only, never "data · geometry"
  // (see geometricData.ts).
  const propertySets = (preExtractedPropertySets ?? extractPropertiesOnDemand(store, localId))
    .filter((set) => !isGeometricDataName(set.name))
    .map((set) => ({
      name: set.name,
      properties: set.properties
        .filter((property) => !isGeometricDataName(property.name))
        .map((property) => ({ name: property.name, value: scaledPropertyValue(property.value, property.dataType, units) })),
    }))
    .filter((set) => set.properties.length > 0);

  // Quantities (Volume/Area/Length/…) ARE part of the data story: adding or
  // removing a quantity set, or editing a quantity, is a real change a
  // coordinator needs to see (#1198 — they were previously excluded wholesale
  // and so never reported). They're geometry-*derived*, so a reshape also
  // recomputes them and reads as "data · geometry" — that's correct, the
  // numbers genuinely changed. A pure translation leaves Volume/Area/Length
  // untouched, so it stays a geometry-only change. Values are rounded to the
  // panel's display precision so re-export float noise can't fabricate a diff.
  const quantitySets = extractQuantitiesOnDemand(store, localId)
    .filter((set) => !isGeometricDataName(set.name))
    .map((set) => ({
      name: set.name,
      quantities: set.quantities
        .filter((quantity) => !isGeometricDataName(quantity.name))
        // Scaled to base SI, then rounded (`quantitySiScale`/`roundToScale`).
        .map((quantity) => ({ name: quantity.name, value: roundToScale(quantity.value * quantitySiScale(quantity, units)) })),
    }))
    .filter((set) => set.quantities.length > 0);

  const typeAssignments = store.relationships
    .getRelated(localId, RelationshipType.DefinesByType, 'inverse')
    .map((typeId) => ({
      globalId: store.entities.getGlobalId(typeId) || undefined,
      name: store.entities.getName(typeId) || undefined,
      type: store.entities.getTypeName(typeId) || undefined,
    }));

  // Resolved material NAMES (never entity references — express ids are
  // reassigned on every save). `extractAllMaterialsOnDemand` follows
  // `IfcMaterialLayerSetUsage`/`IfcMaterialProfileSetUsage` to their sets;
  // `lensMaterialNames` then takes the individual layer/constituent/profile/
  // list-member names. Two proxies re-specified `Soil1` -> `topsoil` went
  // unreported before this — materials were in no comparison channel at all.
  const materials = extractAllMaterialsOnDemand(store, localId).flatMap(lensMaterialNames);
  // Resolved classification references — the same re-specification gap, above.
  const classifications = extractClassificationsOnDemand(store, localId).map(classificationLabel);

  return {
    ifcType,
    name: store.entities.getName(localId) || undefined,
    description: store.entities.getDescription(localId) || undefined,
    objectType: store.entities.getObjectType(localId) || undefined,
    predefinedType: predefinedType != null ? String(predefinedType) : undefined,
    tag: tag != null ? String(tag) : undefined,
    propertySets,
    quantitySets,
    typeAssignments,
    materials,
    classifications,
  };
}
