// SPDX-License-Identifier: MPL-2.0
//! Uncut, uncopied face sets against their authored rows (#8291).
use super::OracleResult;
use ifc_lite_core::{slot, AttributeValue, EntityDecoder, IfcType};
use ifc_lite_retained_native::{oracle::{face_set_closure, face_sets}, ShapeOnlyProduct};

fn row_key(role: &str) -> Option<u32> {
    role.strip_prefix("row(")?.strip_suffix(')')?.parse().ok()
}

/// The face sets the file itself puts in this product's or orphan type's Body, directly or
/// through a map, one entry per occurrence, and whether the Body authors anything else.
/// The expectation comes from the source, so lost row keys cannot read as nothing to check.
fn authored_face_sets(product_id: u32, bytes: &[u8]) -> Option<(Vec<u32>, bool)> {
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
    let (mut authored, mut other) = (Vec::new(), false);
    while let Some(representation) = representations.pop() {
        for id in representation.ref_list_at(slot::IfcRepresentation::ITEMS)? {
            let item = decoder.decode_by_id(id).ok()?;
            match item.ifc_type {
                IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork | IfcType::IfcPolygonalFaceSet => authored.push(id),
                IfcType::IfcMappedItem => {
                    let map = decoder.decode_by_id(item.ref_at(slot::IfcMappedItem::MAPPING_SOURCE)?).ok()?;
                    representations.push(decoder.decode_by_id(map.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION)?).ok()?);
                }
                _ => other = true,
            }
        }
    }
    Some((authored, other))
}

/// Marks a product whose every part publishes rows of a face set its source authors open.
pub const AUTHORED_OPEN: &str = "faceSetAuthoredOpen";

/// Every published UV and palette entry against the row its face key names. Affine
/// copies move a part out of the source's frame and keep only the exact comparison.
fn surface(product: &ShapeOnlyProduct, bytes: &[u8], tolerances: &serde_json::Value) -> Vec<OracleResult> {
    let (mut uv, mut palette, mut coverage, mut any) = (0f64, 0f64, 0f64, false);
    for part in &product.parts {
        let (Some(surface), Some(faces)) = (&part.surface, &part.faces) else { continue };
        if !part.source_exact && product.cuts == 0 { continue; }
        any = true;
        let mut decoder = EntityDecoder::new(bytes);
        let units = ifc_lite_geometry::GeometryRouter::with_units(bytes, &mut decoder).unit_scale();
        for (t, &key) in faces.triangles.iter().enumerate() {
            let key = &faces.table[key as usize];
            let Some(row) = row_key(&key.role) else {
                coverage += f64::from(surface.texture.as_ref().is_some_and(|x| x.textured[t]));
                coverage += f64::from(surface.palette.as_ref().is_some_and(|x| x.triangles[t] != ifc_lite_processing::element::retained_runtime::NO_PALETTE_ENTRY));
                continue;
            };
            let Ok(item) = decoder.decode_by_id(key.item) else { coverage += 1.; continue };
            let Some(set) = face_sets::authored(&item, &mut decoder, units) else { coverage += 1.; continue };
            let authored = face_sets::authored_surface(bytes, &item, &mut decoder);
            if let (Some(published), Some(source)) = (&surface.palette, &authored.palette) {
                palette += f64::from(source.get(row as usize) != Some(&published.triangles[t]));
            }
            let (Some(published), Some(source)) = (&surface.texture, &authored.uvs) else { continue };
            coverage += f64::from(!published.textured[t]);
            for corner in 0..3 {
                let at = part.indices[t * 3 + corner] as usize * 3;
                let p = [part.positions[at], part.positions[at + 1], part.positions[at + 2]];
                let published_uv = [published.uvs[(t * 3 + corner) * 2], published.uvs[(t * 3 + corner) * 2 + 1]];
                uv = uv.max(set.rows.get(row as usize).zip(source.get(row as usize))
                    .and_then(|(authored_row, uvs)| face_sets::uv_deviation(authored_row, uvs, p, published_uv))
                    .unwrap_or(f64::INFINITY));
            }
        }
    }
    if !any { return Vec::new(); }
    let result = |family, value: f64, limit: f64| OracleResult { family, value, limit, pass: value.is_finite() && value <= limit, gated: true, ..Default::default() };
    vec![result("faceSetUvAffine", uv, tolerances["faceSetUvAffineAbsolute"].as_f64().unwrap_or(f64::NAN)),
        result("faceSetPaletteRow", palette, 0.), result("faceSetSurfaceCoverage", coverage, 0.)]
}

pub(crate) fn check(product: &ShapeOnlyProduct, bytes: &[u8], tolerances: &serde_json::Value) -> Vec<OracleResult> {
    let mut results = surface(product, bytes, tolerances);
    results.extend(rows(product, bytes, tolerances));
    results
}

fn rows(product: &ShapeOnlyProduct, bytes: &[u8], tolerances: &serde_json::Value) -> Vec<OracleResult> {
    let mut worst = face_sets::RowDeviation::default();
    let mut any = false;
    let mut failure = None;
    // Unknown (`$`/.U.) or closed sets, and parts of any other kind, keep the closed-solid checks.
    let mut open = !product.parts.is_empty() && product.cuts == 0;
    let mut published = Vec::new();
    for part in &product.parts {
        let Some(faces) = part.faces.as_ref().filter(|_| part.source_exact) else { open = false; continue };
        // Any row key opts the part in: the first key's role must not be able to skip it, and
        // a triangle keyed to anything else then fails the corner check.
        let Some(first) = faces.table.iter().find(|key| row_key(&key.role).is_some()) else {
            any = true;
            open = false;
            failure = Some(format!("part of #{} is source-exact but has no row key", product.product_id));
            continue;
        };
        any = true;
        published.push(first.item);
        let mut decoder = EntityDecoder::new(bytes);
        let units = ifc_lite_geometry::GeometryRouter::with_units(bytes, &mut decoder).unit_scale();
        let item = decoder.decode_by_id(first.item).ok();
        let set = item.as_ref().filter(|item| matches!(item.ifc_type, IfcType::IfcTriangulatedFaceSet
            | IfcType::IfcTriangulatedIrregularNetwork | IfcType::IfcPolygonalFaceSet))
            .and_then(|item| face_sets::authored(item, &mut decoder, units));
        open &= item.as_ref().is_some_and(face_set_closure::authored_open) && faces.table.iter().all(|key| key.item == first.item);
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
        let source = authored_face_sets(product.product_id, bytes);
        let (mut authored, other) = source.clone().unwrap_or_default();
        if let Some(missing) = authored.iter().copied().find(|&item| !keyed(item)) {
            failure = Some(format!("#{} authors face set #{missing} but published no row key for it", product.product_id));
        }
        // Open waives the exact area that would see a lost, extra or misplaced copy or a lost
        // non-set item: the Body must author only face sets, each once (published keys do not
        // name the mapped occurrence), and publish exactly one part per set.
        authored.sort_unstable();
        published.sort_unstable();
        open &= source.is_some() && !other && authored.windows(2).all(|w| w[0] != w[1]) && authored == published;
    }
    if !any && failure.is_none() { return Vec::new(); }
    let result = |family, value: f64, limit: f64| OracleResult { family, value, limit,
        pass: value.is_finite() && value <= limit && failure.is_none(), gated: true, reason: failure.clone(), ..Default::default() };
    let mut results = vec![
        result("faceSetCorner", worst.corner_m, tolerances["faceSetCornerMetres"].as_f64().unwrap_or(f64::NAN)),
        result("faceSetRowArea", worst.area_relative, tolerances["faceSetRowAreaRelative"].as_f64().unwrap_or(f64::NAN)),
        result("faceSetRowsMissing", worst.missing_rows as f64, 0.),
    ];
    // Report-only marker: the rows above still gate; `Report` skips only closed-solid checks.
    if open && any { results.push(OracleResult { family: AUTHORED_OPEN, value: 1., limit: 0., pass: true, gated: false, ..Default::default() }); }
    results
}
