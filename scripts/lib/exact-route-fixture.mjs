/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Synthetic complete payload for schema/comparator invariant tests, NOT IFC evidence.
import { OPTIONS, INSTANCE, MESH_INSTANCE, EXECUTION_FIELDS } from '../exact-route-schema.mjs';
export const F32 = 'f32:00000000', F64 = 'f64:0000000000000000';
export const matrix = () => Array.from({ length: 16 }, (_, i) => i % 5 === 0 ? 'f64:3ff0000000000000' : F64);
export function captureFixture() {
  const mesh = { express_id: 'u32:1', ifc_type: 'IfcWall', global_id: null, name: null,
    presentation_layer: null, positions: [F32, F32, F32, 'f32:3f800000', F32, F32, F32, 'f32:3f800000', F32],
    normals: [F32, F32, 'f32:3f800000', F32, F32, 'f32:3f800000', F32, F32, 'f32:3f800000'],
    indices: ['u32:0', 'u32:1', 'u32:2'], color: ['f32:3f800000', F32, F32, 'f32:3f800000'],
    material_name: null, geometry_item_id: null, material_id: null, properties: null,
    uvs: [F32, F32, 'f32:3f800000', F32, F32, 'f32:3f800000'],
    texture: { texture_id: 'u32:7', rgba: ['u8:255', 'u8:0', 'u8:0', 'u8:255'], width: 'u32:1', height: 'u32:1',
      url: null, repeat_s: true, repeat_t: false }, geometry_class: 'u8:0', origin: [F64, F64, F64] };
  const instance = id => [`u32:${id}`, 'IfcWall', null, null, null, [...mesh.color], 'u32:1',
    'u128:340282366920938463463374607431768211455', matrix().map(v => v === F64 ? F32 : 'f32:3f800000'), null];
  return { protocol: 'exact-route-v2', fixture_sha256: 'a'.repeat(64), options: OPTIONS,
    scene: { meshes: [{ serialized: mesh, geometry_class: mesh.geometry_class, origin: [...mesh.origin],
      local_bounds: [F32, F32, F32, 'f32:3f800000', 'f32:3f800000', F32], local_to_world: matrix(),
      [MESH_INSTANCE]: [matrix(), null, null, 'u128:340282366920938463463374607431768211455', true] }],
    [INSTANCE]: [instance(1), instance(2), instance(1)], mesh_coordinate_space: 'raw_ifc',
    frame_variant_anchor_placement: ['RawIfc', null, null], frame_world_matrix: matrix(), site_transform: null, building_transform: null,
    metadata: { schema_version: 'IFC4', entity_count: 'u64:3', geometry_entity_count: 'u64:1',
      coordinate_info: { origin_shift: [F64, F64, F64], is_geo_referenced: false }, length_unit_scale: null,
      length_unit_refused: null, georeferencing: null },
    stats: { total_meshes: 'u64:1', total_vertices: 'u64:3', total_triangles: 'u64:1', from_cache: false,
      total_csg_failures: 'u64:0', products_with_failures: 'u64:0', degenerate_triangles_dropped: 'u64:0',
      refused_input_elements: 'u64:0', refused_prepass_records: 'u64:0', geometry_diagnostics: null } },
    execution_only: Object.fromEntries(EXECUTION_FIELDS.map(k => [k, 'u64:0'])) };
}
