// SPDX-License-Identifier: MPL-2.0
//! Uncut face sets against their authored rows (#8291).
use super::OracleResult;
use ifc_lite_core::{slot, EntityDecoder, IfcType};
use ifc_lite_retained_native::{oracle::face_sets, ShapeOnlyProduct};

fn row_key(role: &str) -> Option<u32> {
    role.strip_prefix("row(")?.strip_suffix(')')?.parse().ok()
}

/// Whether the file itself puts a face set in this product's Body, directly or through a map.
/// The expectation comes from the source so that lost row keys cannot read as nothing to check.
fn authors_face_set(product_id: u32, bytes: &[u8]) -> Option<bool> {
    let mut decoder = EntityDecoder::new(bytes);
    let product = decoder.decode_by_id(product_id).ok()?;
    // An index read: a published id can be a type, which has no product Representation.
    let shape = decoder.decode_by_id(product.get_ref(slot::IfcProduct::REPRESENTATION.index())?).ok()?;
    let mut representations = Vec::new();
    for id in shape.ref_list_at(slot::IfcProductDefinitionShape::REPRESENTATIONS)? {
        let representation = decoder.decode_by_id(id).ok()?;
        if representation.string_at(slot::IfcRepresentation::REPRESENTATION_IDENTIFIER) == Some("Body") { representations.push(representation); }
    }
    while let Some(representation) = representations.pop() {
        for id in representation.ref_list_at(slot::IfcRepresentation::ITEMS)? {
            let item = decoder.decode_by_id(id).ok()?;
            match item.ifc_type {
                IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork | IfcType::IfcPolygonalFaceSet => return Some(true),
                IfcType::IfcMappedItem => {
                    let map = decoder.decode_by_id(item.ref_at(slot::IfcMappedItem::MAPPING_SOURCE)?).ok()?;
                    representations.push(decoder.decode_by_id(map.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION)?).ok()?);
                }
                _ => {}
            }
        }
    }
    Some(false)
}

pub(super) fn check(product: &ShapeOnlyProduct, bytes: &[u8], tolerances: &serde_json::Value) -> Vec<OracleResult> {
    let mut worst = face_sets::RowDeviation::default();
    let mut any = false;
    let mut failure = None;
    for part in &product.parts {
        let Some(faces) = &part.faces else { continue };
        // Any row key opts the part in: the first key's role must not be able to skip it, and
        // a triangle keyed to anything else then fails the corner check.
        let Some(first) = faces.table.iter().find(|key| row_key(&key.role).is_some()) else { continue };
        any = true;
        let mut decoder = EntityDecoder::new(bytes);
        let units = ifc_lite_geometry::GeometryRouter::with_units(bytes, &mut decoder).unit_scale();
        let item = decoder.decode_by_id(first.item).ok();
        let set = item.as_ref().filter(|item| matches!(item.ifc_type, IfcType::IfcTriangulatedFaceSet
            | IfcType::IfcTriangulatedIrregularNetwork | IfcType::IfcPolygonalFaceSet))
            .and_then(|item| face_sets::authored(item, &mut decoder, units));
        let Some(set) = set else { failure = Some(format!("#{} has no authored rows", first.item)); continue };
        let keys: Vec<_> = faces.triangles.iter()
            .map(|&k| faces.table.get(k as usize).and_then(|key| row_key(&key.role))).collect();
        let part_worst = face_sets::deviation(&set, &part.positions, &part.indices, &keys);
        worst.corner_m = worst.corner_m.max(part_worst.corner_m);
        worst.area_relative = worst.area_relative.max(part_worst.area_relative);
        worst.missing_rows += part_worst.missing_rows;
    }
    if !any {
        if authors_face_set(product.product_id, bytes) != Some(true) { return Vec::new(); }
        failure = Some(format!("#{} authors a face set but published no row key", product.product_id));
    }
    let result = |family, value: f64, limit: f64| OracleResult { family, value, limit,
        pass: value.is_finite() && value <= limit && failure.is_none(), gated: true, reason: failure.clone(), ..Default::default() };
    vec![
        result("faceSetCorner", worst.corner_m, tolerances["faceSetCornerMetres"].as_f64().unwrap_or(f64::NAN)),
        result("faceSetRowArea", worst.area_relative, tolerances["faceSetRowAreaRelative"].as_f64().unwrap_or(f64::NAN)),
        result("faceSetRowsMissing", worst.missing_rows as f64, 0.),
    ]
}
