/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export const OPTIONS = 'process_geometry/full_pass/default-opening/default-quality/default-features/no-IFC_LITE-overrides';
export const INSTANCE = 'instances_id_type_guid_name_layer_color_template_identity_transform_item';
export const MESH_INSTANCE = 'instance_transform_local_canonical_identity_shareable';
const fail = p => { throw Error(`invalid/incomplete capture: ${p}`); };
export const object = (v, p) => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(p); return v; };
const keys = (v, required, p, optional = []) => {
  object(v, p);
  if (required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => ![...required, ...optional].includes(k))) fail(`${p}.keys`);
};
const str = (v, p) => { if (typeof v !== 'string') fail(p); };
const bool = (v, p) => { if (typeof v !== 'boolean') fail(p); };
const nullable = (v, fn, p) => { if (v !== null) fn(v, p); };
export function uint(v, type, p) {
  if (typeof v !== 'string' || !new RegExp(`^${type}:(0|[1-9][0-9]*)$`).test(v)) fail(p);
  const n = BigInt(v.split(':')[1]);
  if (n >= (1n << BigInt(type.slice(1)))) fail(p);
  return n;
}
function float(v, type, p) {
  const digits = type === 'f32' ? 8 : 16;
  if (typeof v !== 'string' || !new RegExp(`^${type}:[a-f0-9]{${digits}}$`).test(v)) fail(p);
  const bits = BigInt(`0x${v.split(':')[1]}`), mask = type === 'f32' ? 0x7f800000n : 0x7ff0000000000000n;
  if ((bits & mask) === mask) fail(`${p}: nonfinite`);
}
const f32 = (v, p) => float(v, 'f32', p), f64 = (v, p) => float(v, 'f64', p);
const u32 = (v, p) => uint(v, 'u32', p), u64 = (v, p) => uint(v, 'u64', p);
const array = (v, fn, p, length) => {
  if (!Array.isArray(v) || (length !== undefined && v.length !== length)) fail(p);
  v.forEach((x, i) => fn(x, `${p}[${i}]`));
};
const vec = (fn, n) => (v, p) => array(v, fn, p, n);
const mat32 = vec(f32, 16), mat64 = vec(f64, 16), color = vec(f32, 4);
function texture(v, p) {
  keys(v, ['texture_id', 'rgba', 'width', 'height', 'url', 'repeat_s', 'repeat_t'], p);
  u32(v.texture_id, p); const w = u32(v.width, p), h = u32(v.height, p);
  nullable(v.url, str, p); bool(v.repeat_s, p); bool(v.repeat_t, p);
  if (v.rgba !== null) {
    array(v.rgba, (n, q) => uint(n, 'u8', q), p);
    if (!w || !h || BigInt(v.rgba.length) !== w * h * 4n || v.url !== null) fail(`${p}.rgba length/source`);
  } else if (v.url === null) fail(`${p}.missing source`);
}
function mesh(v, p) {
  keys(v, ['serialized', 'geometry_class', 'origin', 'local_bounds', 'local_to_world', MESH_INSTANCE], p);
  const m = v.serialized;
  keys(m, ['express_id', 'ifc_type', 'global_id', 'name', 'presentation_layer', 'positions', 'normals',
    'indices', 'color', 'material_name', 'geometry_item_id', 'material_id', 'properties', 'uvs', 'texture', 'geometry_class', 'origin'], `${p}.serialized`);
  u32(m.express_id, p); str(m.ifc_type, p);
  for (const k of ['global_id', 'name', 'presentation_layer', 'material_name']) nullable(m[k], str, `${p}.${k}`);
  for (const k of ['geometry_item_id', 'material_id']) nullable(m[k], u32, `${p}.${k}`);
  if (m.properties !== null) { object(m.properties, p); Object.values(m.properties).forEach(x => str(x, p)); }
  array(m.positions, f32, `${p}.positions`); array(m.normals, f32, `${p}.normals`, m.positions.length);
  if (!m.positions.length || m.positions.length % 3) fail(`${p}.positions.length`);
  array(m.indices, (n, q) => { if (u32(n, q) >= BigInt(m.positions.length / 3)) fail(q); }, `${p}.indices`);
  if (!m.indices.length || m.indices.length % 3) fail(`${p}.indices.length`);
  color(m.color, p); nullable(m.uvs, vec(f32, m.positions.length / 3 * 2), `${p}.uvs`);
  nullable(m.texture, texture, `${p}.texture`);
  if (m.texture !== null && m.uvs === null) fail(`${p}.texture without UVs`);
  uint(m.geometry_class, 'u8', p); uint(v.geometry_class, 'u8', p);
  vec(f64, 3)(m.origin, p); vec(f64, 3)(v.origin, p);
  if (JSON.stringify(m.origin) !== JSON.stringify(v.origin) || m.geometry_class !== v.geometry_class) fail(`${p}.inconsistent explicit fields`);
  nullable(v.local_bounds, vec(f32, 6), p); nullable(v.local_to_world, mat64, p);
  nullable(v[MESH_INSTANCE], (i, q) => {
    if (!Array.isArray(i) || i.length !== 5) fail(q);
    mat64(i[0], q); nullable(i[1], mat64, q); nullable(i[2], mat64, q); uint(i[3], 'u128', q); bool(i[4], q);
  }, p);
}
function instance(v, p) {
  if (!Array.isArray(v) || v.length !== 10) fail(p);
  u32(v[0], p); str(v[1], p);
  for (const i of [2, 3, 4]) nullable(v[i], str, p);
  color(v[5], p); u32(v[6], p); uint(v[7], 'u128', p); mat32(v[8], p); nullable(v[9], u32, p);
}
function georef(v, p) {
  const floats = ['eastings', 'northings', 'orthogonal_height', 'x_axis_abscissa', 'x_axis_ordinate', 'scale',
    'factor_x', 'factor_y', 'factor_z', 'rotation_degrees'];
  const strings = ['crs_name', 'geodetic_datum', 'vertical_datum', 'map_projection', 'crs_description', 'map_zone', 'map_unit', 'source'];
  keys(v, [...floats, 'transform_matrix', ...strings, 'map_unit_scale'], p);
  floats.forEach(k => f64(v[k], `${p}.${k}`)); mat64(v.transform_matrix, p);
  strings.forEach(k => nullable(v[k], str, p));
  nullable(v.map_unit_scale, f64, p);
}
function metadata(v, p) {
  keys(v, ['schema_version', 'entity_count', 'geometry_entity_count', 'coordinate_info',
    'length_unit_scale', 'length_unit_refused', 'georeferencing'], p);
  str(v.schema_version, p); u64(v.entity_count, p); u64(v.geometry_entity_count, p);
  keys(v.coordinate_info, ['origin_shift', 'is_geo_referenced'], p);
  vec(f64, 3)(v.coordinate_info.origin_shift, p); bool(v.coordinate_info.is_geo_referenced, p);
  nullable(v.length_unit_scale, f64, p); nullable(v.length_unit_refused, u32, p); nullable(v.georeferencing, georef, p);
}
function counts(v, names, p) { keys(v, names, p); names.forEach(k => u64(v[k], `${p}.${k}`)); }
function diagnostics(v, p) {
  const scalar = ['totalCsgFailures', 'productsWithFailures', 'hostsWithOpenings', 'silentNoOps',
    'oversizedRefDrops', 'totalUnsupportedItems'];
  keys(v, ['schemaVersion', ...scalar, 'classification', 'failuresByReason', 'rectFast', 'worstHosts', 'unsupportedItemsByType'], p);
  u32(v.schemaVersion, p); scalar.forEach(k => u64(v[k], `${p}.${k}`));
  counts(v.classification, ['rectangular', 'diagonal', 'nonRectangular', 'total'], p);
  counts(v.rectFast, ['fired', 'openingsCut', 'deferHostNotBox', 'deferNotThrough', 'deferOffFace',
    'deferNearEdge', 'deferNoOpenings', 'deferTooManyOpenings'], p);
  for (const k of ['failuresByReason', 'unsupportedItemsByType']) array(v[k], (x, q) => {
    keys(x, ['reason', 'count'], q); str(x.reason, q); u64(x.count, q);
  }, p);
  array(v.worstHosts, (x, q) => {
    keys(x, ['productId', 'ifcType', 'openings', 'csgFailures', 'firstFailureLabel', 'bbox', 'triangleCount'], q);
    u32(x.productId, q); str(x.ifcType, q); u64(x.openings, q); u64(x.csgFailures, q);
    nullable(x.firstFailureLabel, str, q); nullable(x.triangleCount, u64, q);
    nullable(x.bbox, b => { keys(b, ['min', 'max'], q); vec(f32, 3)(b.min, q); vec(f32, 3)(b.max, q); }, q);
  }, p);
}
export const EXECUTION_FIELDS = ['parse_time_ms', 'entity_scan_time_ms', 'lookup_time_ms', 'preprocess_time_ms',
  'geometry_time_ms', 'total_time_ms', 'faceted_brep_time_ms', 'point_cache_hits', 'point_cache_misses'];
export function validateCapture(v, expectedOptions = OPTIONS) {
  keys(v, ['protocol', 'fixture_sha256', 'options', 'scene', 'execution_only'], '$');
  if (v.protocol !== 'exact-route-v2' || v.options !== expectedOptions || expectedOptions !== OPTIONS ||
      !/^[a-f0-9]{64}$/.test(v.fixture_sha256)) fail('protocol/options/fixture');
  const s = v.scene;
  keys(s, ['meshes', INSTANCE, 'mesh_coordinate_space', 'frame_variant_anchor_placement', 'frame_world_matrix',
    'site_transform', 'building_transform', 'metadata', 'stats'], '$.scene');
  array(s.meshes, mesh, '$.scene.meshes'); if (!s.meshes.length) fail('empty meshes');
  array(s[INSTANCE], instance, '$.scene.instances');
  // Check references without deduplicating occurrences or changing their order.
  for (const i of s[INSTANCE]) if (!s.meshes.some(m => m.serialized.express_id === i[6])) fail('instance template absent');
  const f = s.frame_variant_anchor_placement;
  if (!Array.isArray(f) || f.length !== 3) fail('frame tuple');
  const tag = { RawIfc: 'raw_ifc', ModelRtc: 'model_rtc', SiteLocal: 'site_local' }[f[0]];
  if (!tag || tag !== s.mesh_coordinate_space) fail('frame tag');
  if (f[0] === 'ModelRtc') { vec(f64, 3)(f[1], 'frame anchor'); if (f[2] !== null) fail('frame placement'); }
  else if (f[0] === 'SiteLocal') { mat64(f[2], 'frame placement'); if (f[1] !== null) fail('frame anchor'); }
  else if (f[1] !== null || f[2] !== null) fail('raw frame');
  mat64(s.frame_world_matrix, 'world matrix'); nullable(s.site_transform, mat64, 'site'); nullable(s.building_transform, mat64, 'building');
  metadata(s.metadata, 'metadata');
  const names = ['total_meshes', 'total_vertices', 'total_triangles', 'total_csg_failures', 'products_with_failures',
    'degenerate_triangles_dropped', 'refused_input_elements', 'refused_prepass_records'];
  keys(s.stats, [...names, 'from_cache', 'geometry_diagnostics'], 'stats'); names.forEach(k => u64(s.stats[k], k));
  bool(s.stats.from_cache, 'cache'); nullable(s.stats.geometry_diagnostics, diagnostics, 'diagnostics');
  const totals = [s.meshes.length, s.meshes.reduce((n, m) => n + m.serialized.positions.length / 3, 0),
    s.meshes.reduce((n, m) => n + m.serialized.indices.length / 3, 0)];
  ['total_meshes', 'total_vertices', 'total_triangles'].forEach((k, i) => {
    if (u64(s.stats[k], k) !== BigInt(totals[i])) fail(`stats.${k} inconsistency`);
  });
  counts(v.execution_only, EXECUTION_FIELDS, 'execution_only');
}
