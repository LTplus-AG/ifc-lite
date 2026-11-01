// SPDX-License-Identifier: MPL-2.0
//! Uncut face sets against their authored rows (#8291).
use super::OracleResult;
use ifc_lite_core::{slot, AttributeValue, EntityDecoder, IfcType};
use ifc_lite_retained_native::{oracle::face_sets, ShapeOnlyProduct};

fn row_key(role: &str) -> Option<u32> {
    role.strip_prefix("row(")?.strip_suffix(')')?.parse().ok()
}

/// The face sets the file itself puts in this product's or orphan type's Body, directly or
/// through a map. The expectation comes from the source, so lost row keys cannot read as
/// nothing to check.
fn authored_face_sets(product_id: u32, bytes: &[u8]) -> Option<Vec<u32>> {
    let mut decoder = EntityDecoder::new(bytes);
    let product = decoder.decode_by_id(product_id).ok()?;
    let mut roots = Vec::new();
    // Index reads: a published id can be either kind, and each lacks the other's attribute.
    if let Some(shape) = product.get_ref(slot::IfcProduct::REPRESENTATION.index()) {
        roots = decoder.decode_by_id(shape).ok()?.ref_list_at(slot::IfcProductDefinitionShape::REPRESENTATIONS)?;
    } else if let Some(maps) = product.get(slot::IfcTypeProduct::REPRESENTATION_MAPS.index()).and_then(AttributeValue::as_list) {
        for map in maps.iter().filter_map(AttributeValue::as_entity_ref) {
            roots.push(decoder.decode_by_id(map).ok()?.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION)?);
        }
    }
    let mut representations = Vec::new();
    for id in roots {
        let representation = decoder.decode_by_id(id).ok()?;
        if representation.string_at(slot::IfcRepresentation::REPRESENTATION_IDENTIFIER) == Some("Body") { representations.push(representation); }
    }
    let mut authored = Vec::new();
    while let Some(representation) = representations.pop() {
        for id in representation.ref_list_at(slot::IfcRepresentation::ITEMS)? {
            let item = decoder.decode_by_id(id).ok()?;
            match item.ifc_type {
                IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork | IfcType::IfcPolygonalFaceSet => authored.push(id),
                IfcType::IfcMappedItem => {
                    let map = decoder.decode_by_id(item.ref_at(slot::IfcMappedItem::MAPPING_SOURCE)?).ok()?;
                    representations.push(decoder.decode_by_id(map.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION)?).ok()?);
                }
                _ => {}
            }
        }
    }
    Some(authored)
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
    // A cut may legitimately consume a whole item; uncut, every authored set must publish rows.
    if product.cuts == 0 {
        let keyed = |item: u32| product.parts.iter().filter_map(|part| part.faces.as_ref())
            .any(|faces| faces.table.iter().any(|key| key.item == item && row_key(&key.role).is_some()));
        if let Some(missing) = authored_face_sets(product.product_id, bytes).unwrap_or_default().into_iter().find(|&item| !keyed(item)) {
            failure = Some(format!("#{} authors face set #{missing} but published no row key for it", product.product_id));
        }
    }
    if !any && failure.is_none() { return Vec::new(); }
    let result = |family, value: f64, limit: f64| OracleResult { family, value, limit,
        pass: value.is_finite() && value <= limit && failure.is_none(), gated: true, reason: failure.clone(), ..Default::default() };
    vec![
        result("faceSetCorner", worst.corner_m, tolerances["faceSetCornerMetres"].as_f64().unwrap_or(f64::NAN)),
        result("faceSetRowArea", worst.area_relative, tolerances["faceSetRowAreaRelative"].as_f64().unwrap_or(f64::NAN)),
        result("faceSetRowsMissing", worst.missing_rows as f64, 0.),
    ]
}
