/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-derived entity type-set machinery shared by `reference-collector.ts`
 * (visible-only / merged export root classification) and `subset-roots.ts`
 * (anonymized-subset root classification, #2934) — split out of
 * `reference-collector.ts` once both consumers needed the same "walk the
 * schema table and collect every descendant of X" primitive instead of a
 * second, hand-maintained copy. `reference-collector.ts` re-exports
 * `INFRASTRUCTURE_TYPES`, `PRODUCT_TYPES` and `collectDescendantNames` so
 * every existing import path keeps working.
 */

import {
  ENTITIES_IFC2X3,
  ENTITIES_IFC4,
  ENTITIES_IFC4X3,
  type IfcEntityInfo,
} from '@ifc-lite/data';

/**
 * Entity types that form the shared file infrastructure and must always be
 * included. Exported for `subset-roots.ts` (`getSubsetEntityIds`), which
 * needs the same "always a root" set the `visibleOnly` closure uses — see
 * `reference-collector.ts`'s own doc for why these can never be excluded.
 */
export const INFRASTRUCTURE_TYPES = new Set([
  'IFCOWNERHISTORY',
  'IFCAPPLICATION',
  'IFCPERSON',
  'IFCORGANIZATION',
  'IFCPERSONANDORGANIZATION',
  'IFCUNITASSIGNMENT',
  'IFCSIUNIT',
  'IFCDERIVEDUNIT',
  'IFCDERIVEDUNITELEMENT',
  'IFCCONVERSIONBASEDUNIT',
  'IFCMEASUREWITHUNIT',
  'IFCDIMENSIONALEXPONENTS',
  'IFCMONETARYUNIT',
  'IFCGEOMETRICREPRESENTATIONCONTEXT',
  'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
]);

/**
 * Every IfcProduct subtype in every schema this package can export, derived
 * from `@ifc-lite/data`'s generated entity tables rather than hand-listed.
 *
 * A product type missing from this set is not classified as a product, so under
 * `visibleOnly` it never becomes a root: the element — and the geometry only it
 * references — is silently absent from the exported file even though the user
 * never hid it. The hand-written predecessor was derived from IFC4 + IFC4X3
 * alone and therefore dropped every IFC2X3-only product
 * (`IfcElectricDistributionPoint`, `IfcElectricalElement`,
 * `IfcEquipmentElement`, the edge features, the varying structural actions)
 * from a visible-only export of a legacy model.
 *
 * Deriving it means a schema-table regeneration cannot leave this classifier
 * behind. Spatial structure and infrastructure are matched before this set, so
 * its overlap with `SPATIAL_STRUCTURE_TYPES` is harmless. The `hiddenIds`
 * fallback below still catches types no bundled schema declares.
 */
/** Exported for the drift test that diffs it against the schema tables. */
export const PRODUCT_TYPES: ReadonlySet<string> = buildProductTypes();

function buildProductTypes(): Set<string> {
  const products = new Set<string>();
  for (const table of [ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3]) {
    collectDescendantNames(table, 'IfcProduct', products);
  }
  return products;
}

/**
 * Add the upper-cased name of every `ancestor` descendant declared in
 * `table`. Generalised from a product-only `collectProductNames` (#2934) so
 * `subset-roots.ts` can derive `IFC_ROOT_TYPES` — every `IfcRoot` descendant
 * — from the same walk instead of a second, hand-maintained copy; behaviour
 * for the existing `'IfcProduct'` caller (`buildProductTypes`) is unchanged.
 */
export function collectDescendantNames(
  table: readonly IfcEntityInfo[],
  ancestor: string,
  out: Set<string>,
): void {
  const parentOf = new Map<string, string | null | undefined>();
  for (const entity of table) parentOf.set(entity.name, entity.parent);

  for (const entity of table) {
    // The walk starts at the parent, so `ancestor` itself — abstract, and
    // never instantiated — is not added, while every descendant is.
    let cursor = parentOf.get(entity.name) ?? null;
    // Depth-bounded so a malformed table cannot spin here; the deepest IFC
    // inheritance chain is far under this bound.
    for (let depth = 0; cursor !== null && depth < 64; depth++) {
      if (cursor === ancestor) {
        out.add(entity.name.toUpperCase());
        break;
      }
      cursor = parentOf.get(cursor) ?? null;
    }
  }
}
