// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { MaterialAssociation } from './data-model-decoder.js';
import { nullableFloat64Column } from './parquet-nullable.js';

type MaterialTable = {
  getChild(name: string): { toArray(): unknown; get(index: number): unknown } | null;
};

/** Decode the material table, including legacy payloads without v8 fields. */
export function decodeMaterialAssociations(t: MaterialTable): MaterialAssociation[] {
  const materials: MaterialAssociation[] = [];
  const elementIds = t.getChild('element_id')?.toArray() as Uint32Array;
  const setNames = t.getChild('set_name')?.toArray() as (string | null)[];
  const layerIndices = t.getChild('layer_index')?.toArray() as Uint32Array;
  const materialNames = t.getChild('material_name')?.toArray() as (string | null)[];
  const materialNamePresence = t.getChild('material_name_present');
  const materialIdsChild = t.getChild('material_id');
  const associationIds = t.getChild('association_id')?.toArray() as Uint32Array | undefined;
  const definitionIds = t.getChild('definition_id')?.toArray() as Uint32Array | undefined;
  const memberCounts = t.getChild('member_count')?.toArray() as Uint32Array | undefined;
  const kinds = t.getChild('kind')?.toArray() as (MaterialAssociation['kind'] | null)[] | undefined;
  const memberNames = t.getChild('member_name')?.toArray() as (string | null)[] | undefined;
  const materialCategories = t.getChild('material_category')?.toArray() as (string | null)[] | undefined;
  const fractions = nullableFloat64Column(t, 'fraction');
  const thicknesses = nullableFloat64Column(t, 'thickness');
  const ventChild = t.getChild('is_ventilated');
  const categories = t.getChild('category')?.toArray() as (string | null)[];
  for (let i = 0; i < elementIds.length; i++) {
    const vent = ventChild?.get(i);
    materials.push({
      element_id: elementIds[i],
      association_id: associationIds?.[i],
      definition_id: definitionIds?.[i],
      member_count: memberCounts?.[i],
      kind: kinds?.[i] ?? undefined,
      set_name: setNames?.[i] ?? undefined,
      layer_index: layerIndices[i],
      material_name: materialNames?.[i] ?? '',
      material_name_present: materialNamePresence?.get(i) as boolean | undefined,
      material_id: (materialIdsChild?.get(i) as number | null | undefined) ?? undefined,
      member_name: memberNames?.[i] ?? undefined,
      material_category: materialCategories?.[i] ?? undefined,
      fraction: fractions?.[i] ?? undefined,
      thickness: thicknesses?.[i] ?? undefined,
      is_ventilated: vent === null || vent === undefined ? undefined : Boolean(vent),
      category: categories?.[i] ?? undefined,
    });
  }
  return materials;
}
