// SPDX-License-Identifier: MPL-2.0
//! Source-derived orphan type quantities, independent of retained plans and meshes.
use super::math::{extend_bbox, multiply, transform, IDENTITY};
use ifc_lite_core::{slot, EntityDecoder, IfcType};
use ifc_lite_geometry::{analytic::AnalyticCurveSegment, GeometryRouter};
use ifc_lite_processing::{extrusion_nominal_quantities, AnalyticQuantitySources};

/// A complete sum over supported extrusion leaves, in absolute IFC world metres.
#[derive(Debug)]
pub struct TypeMapExpectation {
    pub parts: usize,
    pub volume: f64,
    pub bbox: Option<[f64; 6]>,
}

struct Item {
    id: u32,
    frame: [f64; 16],
    path: Vec<u32>,
}

/// Walk the caller's exact-planned orphan maps. A missing definition or unsupported
/// leaf returns no oracle, never an expectation for a supported subset.
pub fn expected(bytes: &[u8], sources: &AnalyticQuantitySources, maps: &[(u32, u8)])
    -> Result<Option<TypeMapExpectation>, String> {
    let mut decoder = EntityDecoder::new(bytes);
    // The source definitions are in raw IFC units. Apply their unit scale once
    // at the root; all nested transforms use the canonical raw-unit resolver.
    let router = GeometryRouter::with_scale(1.);
    let scale = sources.extrusion_definitions.length_unit_scale;
    let mut units = IDENTITY;
    for i in [0, 5, 10] { units[i] = scale; }
    let mut stack = Vec::new();
    for &(id, class) in maps.iter().rev() {
        if class != 1 { return Ok(None); }
        let map = decoder.decode_by_id(id).map_err(|e| e.to_string())?;
        let origin = router.mapping_origin_transform(&map, &mut decoder).map_err(|e| e.to_string())?
            .map(|m| ifc_lite_geometry::math::mat4::col_major_array(&m)).unwrap_or(IDENTITY);
        push_items(&map, multiply(&units, &origin), vec![id], &mut decoder, &mut stack)?;
    }
    let mut result = TypeMapExpectation { parts: 0, volume: 0., bbox: Some(empty_bbox()) };
    // Path-scoped revisits preserve repeated instances; the work bound also
    // bounds an acyclic expanding DAG without a recursive stack.
    let mut work = 0usize;
    while let Some(node) = stack.pop() {
        work += 1;
        if work > 100_000 || node.path.contains(&node.id) {
            return Err(format!("type-map source walk exceeded its work bound or cycled at #{}", node.id));
        }
        let item = decoder.decode_by_id(node.id).map_err(|e| e.to_string())?;
        match item.ifc_type {
            IfcType::IfcMappedItem => {
                let map_id = item.ref_at(slot::IfcMappedItem::MAPPING_SOURCE).ok_or("mapped item missing MappingSource")?;
                if node.path.contains(&map_id) { return Err(format!("type-map source cycle at #{map_id}")); }
                let map = decoder.decode_by_id(map_id).map_err(|e| e.to_string())?;
                let local = router.resolve_scaled_mapped_item_transform(&item, &map, &mut decoder)
                    .map_err(|e| e.to_string())?.unwrap_or(IDENTITY);
                let mut path = node.path;
                path.extend([node.id, map_id]);
                push_items(&map, multiply(&node.frame, &local), path, &mut decoder, &mut stack)?;
            }
            IfcType::IfcExtrudedAreaSolid => {
                let extracted;
                let source = if let Some(definition) = sources.extrusion_definitions.sources.iter()
                    .find(|definition| definition.key.solid_id == node.id) {
                    &definition.source
                } else {
                    // The occurrence inventory does not visit orphan-only leaves.
                    // Use its canonical source extractor without adding an occurrence.
                    extracted = ifc_lite_geometry::analytic::extract_analytic_extrusion(&item, &mut decoder);
                    &extracted
                };
                let Some(quantity) = extrusion_nominal_quantities(source) else { return Ok(None); };
                let m = &node.frame;
                let determinant = m[0] * (m[5] * m[10] - m[9] * m[6])
                    - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
                result.volume += determinant.abs() * quantity.nominal_volume;
                result.parts += 1;
                let local_bbox = local_bbox(source);
                match (&mut result.bbox, local_bbox) {
                    (Some(bbox), Some(local)) => {
                        for x in [local[0], local[3]] {
                            for y in [local[1], local[4]] {
                                for z in [local[2], local[5]] { extend_bbox(bbox, transform(m, [x, y, z])); }
                            }
                        }
                    }
                    _ => result.bbox = None,
                }
            }
            _ => return Ok(None),
        }
    }
    if !result.volume.is_finite() || result.bbox.is_some_and(|b| b.iter().any(|v| !v.is_finite())) {
        return Err("nonfinite type-map source quantities".into());
    }
    Ok((result.parts > 0).then_some(result))
}

fn empty_bbox() -> [f64; 6] {
    [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY]
}
fn local_bbox(source: &ifc_lite_geometry::analytic::AnalyticExtrusion) -> Option<[f64; 6]> {
    let profile = source.profile.as_ref()?;
    let solid = source.position_matrix.as_ref().unwrap_or(&IDENTITY);
    let profile_frame = profile.profile_position.as_ref().unwrap_or(&IDENTITY);
    let axis = source.axis_unit_vector?;
    let depth = source.depth?;
    let mut bbox = empty_bbox();
    for segment in profile.loops.iter().flat_map(|boundary| &boundary.segments) {
        let AnalyticCurveSegment::Line { start, end } = segment else { return None; };
        for point in [*start, *end] {
            let p = transform(profile_frame, point);
            for height in [0., depth] {
                extend_bbox(&mut bbox, transform(solid, std::array::from_fn(|i| p[i] + height * axis[i])));
            }
        }
    }
    Some(bbox)
}
fn push_items(map: &ifc_lite_core::DecodedEntity, frame: [f64; 16], path: Vec<u32>,
    decoder: &mut EntityDecoder, stack: &mut Vec<Item>) -> Result<(), String> {
    if map.ifc_type != IfcType::IfcRepresentationMap { return Err("expected IfcRepresentationMap".into()); }
    let id = map.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION).ok_or("map missing MappedRepresentation")?;
    let representation = decoder.decode_by_id(id).map_err(|e| e.to_string())?;
    let ids = representation.ref_list_at(slot::IfcRepresentation::ITEMS).ok_or("representation missing or invalid Items")?;
    if stack.len().saturating_add(ids.len()) > 100_000 { return Err("type-map source frontier exceeds work bound".into()); }
    for &id in ids.iter().rev() {
        stack.push(Item { id, frame, path: path.clone() });
    }
    Ok(())
}
