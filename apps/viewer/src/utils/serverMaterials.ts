/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MaterialInfo } from '@ifc-lite/parser';
import type { MaterialAssociation } from '@ifc-lite/server-client';

/** Reassemble the server's flat rows by relationship, preserving separate
 * associations even when their sets share a name or have no name. Older wire
 * rows lack `kind`/identity and cannot be used to assert a value mismatch. */
export function resolvedServerMaterials(rows: readonly MaterialAssociation[]): Map<number, Map<number, MaterialInfo>> {
  const groups = new Map<number, Map<number, MaterialAssociation[]>>();
  for (const row of rows) {
    if (row.association_id === undefined || row.definition_id === undefined ||
        row.member_count === undefined || !row.kind) continue;
    let byAssociation = groups.get(row.element_id);
    if (!byAssociation) groups.set(row.element_id, byAssociation = new Map());
    const group = byAssociation.get(row.association_id);
    if (group) group.push(row);
    else byAssociation.set(row.association_id, [row]);
  }

  const result = new Map<number, Map<number, MaterialInfo>>();
  for (const [elementId, associations] of groups) {
    const definitions = new Map<number, MaterialInfo>();
    for (const rows of associations.values()) {
      const first = rows[0];
      // A damaged or mixed-kind group must remain unresolved at the call site.
      if (rows.some((r) => r.kind !== first.kind || r.definition_id !== first.definition_id ||
          r.member_count !== first.member_count)) continue;
      const ordered = [...rows].sort((a, b) => a.layer_index - b.layer_index);
      if (first.member_count !== ordered.length || ordered.some((r, index) => r.layer_index !== index)) continue;
      // A nonempty name proves presence even in older payloads. An empty
      // name without the presence bit could mean authored '' or STEP null.
      if (ordered.some((r) => r.material_name_present === undefined && r.material_name === '')) continue;
      const hasMaterialName = (r: MaterialAssociation): boolean => r.material_name_present ?? r.material_name !== '';
      if (first.kind === 'IfcMaterialList' && ordered.some((r) => !hasMaterialName(r) && r.material_id === undefined)) continue;
      let info: MaterialInfo;
      switch (first.kind) {
        case 'IfcMaterial':
          info = { type: 'Material', name: hasMaterialName(first) ? first.material_name : undefined,
            category: first.material_category ?? first.category };
          break;
        case 'IfcMaterialList':
          info = { type: 'MaterialList', materials: ordered.map((r) => ({
            name: hasMaterialName(r) ? r.material_name : `Material #${r.material_id}`,
            ...(r.material_category ? { category: r.material_category } : {}),
          })) };
          break;
        case 'IfcMaterialLayerSet':
          info = { type: 'MaterialLayerSet', name: first.set_name, layers: ordered.map((r) => ({
            materialName: hasMaterialName(r) ? r.material_name : undefined, name: r.member_name,
            materialCategory: r.material_category, category: r.category,
            thickness: r.thickness, isVentilated: r.is_ventilated,
          })) };
          break;
        case 'IfcMaterialConstituentSet':
          info = { type: 'MaterialConstituentSet', name: first.set_name, constituents: ordered.map((r) => ({
            materialName: hasMaterialName(r) ? r.material_name : undefined, name: r.member_name,
            materialCategory: r.material_category, category: r.category,
            fraction: r.fraction,
          })) };
          break;
        case 'IfcMaterialProfileSet':
          info = { type: 'MaterialProfileSet', name: first.set_name, profiles: ordered.map((r) => ({
            materialName: hasMaterialName(r) ? r.material_name : undefined, name: r.member_name,
            materialCategory: r.material_category, category: r.category,
          })) };
          break;
        default:
          continue;
      }
      definitions.set(first.definition_id!, info);
    }
    if (definitions.size) result.set(elementId, definitions);
  }
  return result;
}
