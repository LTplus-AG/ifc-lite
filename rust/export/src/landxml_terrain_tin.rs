// SPDX-License-Identifier: MPL-2.0
//! One selected terrain's authored triangulation, in map metres.
//!
//! The faces are `CoordIndex` as authored (through `PnIndex` when present):
//! nothing is re-triangulated, repaired, or read from loose
//! `IfcCartesianPoint`s. Anything else is refused with the reason.

use std::collections::HashSet;

use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;

use super::georef::{decode, text, Crs, ModelFacts};
use crate::step_map_transform::preflight;

pub(super) struct Terrain {
    pub product_id: u32,
    pub global_id: Option<String>,
    pub name: String,
    /// `(northing, easting, elevation)` metres, in authored vertex order.
    pub points: Vec<[f64; 3]>,
    /// 1-based indices into `points`.
    pub faces: Vec<[usize; 3]>,
    pub crs: Crs,
}

pub(super) fn read_terrain(
    id: u32,
    facts: &ModelFacts,
    router: &GeometryRouter,
    validated: &mut HashSet<u32>,
    decoder: &mut EntityDecoder,
) -> Result<Terrain, String> {
    let product = decode(decoder, id)?;
    if !matches!(product.ifc_type, IfcType::IfcGeographicElement | IfcType::IfcSite) {
        return Err(format!("#{id} is an {}; only an IfcGeographicElement or IfcSite terrain is exported as a LandXML surface", product.ifc_type.name()));
    }
    let (face_set, context) = face_set(&product, decoder)?;
    let frame = facts.frame(context, decoder)?;
    let vertices = vertices(&face_set, decoder)?;
    let faces = faces(&face_set, vertices.len())?;

    preflight::placement(&product, router, validated, decoder)?;
    let placement = router.resolve_scaled_placement_strict(&product, decoder).map_err(|error| error.to_string())?;
    let points: Vec<[f64; 3]> = vertices.iter().map(|&[x, y, z]| {
        // Column-major 4x4, in project units (the router's default unit scale).
        let m = &placement;
        frame.to_map_metres(
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
        )
    }).collect();
    if points.iter().flatten().any(|value| !value.is_finite()) {
        return Err(format!("the placement and map conversion of #{id} produce non-finite map coordinates"));
    }
    for (number, face) in faces.iter().enumerate() {
        if super::degenerate(face.map(|index| points[index - 1])) {
            return Err(format!("face {} of #{id} is degenerate in map coordinates", number + 1));
        }
    }
    let global_id = text(&product, 0);
    let name = text(&product, 2).or_else(|| global_id.clone()).unwrap_or_else(|| format!("#{id}"));
    Ok(Terrain { product_id: id, global_id, name, points, faces, crs: frame.crs })
}

/// The product's single `IfcTriangulatedFaceSet` and the context it is authored in.
fn face_set(product: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<(DecodedEntity, u32), String> {
    let id = product.id;
    let shape = product.get_ref(6).ok_or_else(|| format!("#{id} has no Representation"))?;
    let mut found = Vec::new();
    for representation in decode(decoder, shape)?.get_refs(2).unwrap_or_default() {
        let representation = decode(decoder, representation)?;
        for item in representation.get_refs(3).unwrap_or_default() {
            let item = decode(decoder, item)?;
            if item.ifc_type.is_subtype_of(IfcType::IfcTriangulatedFaceSet) {
                let context = representation.get_ref(0)
                    .ok_or_else(|| format!("representation #{} has no ContextOfItems", representation.id))?;
                found.push((item, context));
            }
        }
    }
    let (face_set, context) = match found.len() {
        1 => found.remove(0),
        0 => return Err(format!("#{id} has no IfcTriangulatedFaceSet in its representation; only an authored triangulated surface is exported, nothing is re-triangulated")),
        n => return Err(format!("#{id} has {n} triangulated face sets; author one terrain surface per product")),
    };
    // A TIN's Flags can mark breaklines, voids or hidden faces. Only a TIN
    // whose every flag is 0 (no flag set, ifc-lite's own LandXML→IFC output)
    // says nothing a plain face list loses.
    if face_set.ifc_type == IfcType::IfcTriangulatedIrregularNetwork {
        let plain = face_set.get_list(5).is_some_and(|flags| flags.iter().all(|flag| matches!(flag, AttributeValue::Integer(0))));
        if !plain {
            return Err(format!("IfcTriangulatedIrregularNetwork #{} sets Flags, which LandXML faces cannot carry; hidden or void faces are not published", face_set.id));
        }
    }
    Ok((face_set, context))
}

/// Authored vertices in project units, with `PnIndex` resolved.
fn vertices(face_set: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<Vec<[f64; 3]>, String> {
    let list = face_set.get_ref(0).ok_or_else(|| format!("#{} has no Coordinates", face_set.id))?;
    let list = decode(decoder, list)?;
    if list.ifc_type != IfcType::IfcCartesianPointList3D {
        return Err(format!("Coordinates #{} is not an IfcCartesianPointList3D", list.id));
    }
    let mut coordinates = Vec::new();
    for (index, point) in list.get_list(0).unwrap_or_default().iter().enumerate() {
        let values: Option<Vec<f64>> = point.as_list().filter(|values| values.len() == 3)
            .and_then(|values| values.iter().map(AttributeValue::as_float).collect());
        match values.as_deref() {
            Some(&[x, y, z]) if [x, y, z].iter().all(|value| value.is_finite()) => coordinates.push([x, y, z]),
            _ => return Err(format!("coordinate {} of #{} is not a finite 3D point", index + 1, list.id)),
        }
    }
    let Some(pn_index) = face_set.get(4).filter(|attr| !attr.is_null()) else { return Ok(coordinates) };
    let pn_index = pn_index.as_list().filter(|items| !items.is_empty())
        .ok_or_else(|| format!("PnIndex of #{} is empty", face_set.id))?;
    pn_index.iter().map(|item| one_based(item, coordinates.len()).map(|index| coordinates[index - 1]))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| format!("PnIndex of #{} references a coordinate that does not exist", face_set.id))
}

/// `CoordIndex` as authored: 1-based triples of distinct vertices.
fn faces(face_set: &DecodedEntity, vertex_count: usize) -> Result<Vec<[usize; 3]>, String> {
    if vertex_count < 3 {
        return Err(format!("#{} has {vertex_count} vertices; a surface needs at least three", face_set.id));
    }
    let triangles = face_set.get_list(3).filter(|triangles| !triangles.is_empty())
        .ok_or_else(|| format!("#{} has no CoordIndex faces", face_set.id))?;
    triangles.iter().enumerate().map(|(number, triangle)| {
        let indices: Option<Vec<usize>> = triangle.as_list().filter(|items| items.len() == 3)
            .and_then(|items| items.iter().map(|item| one_based(item, vertex_count)).collect());
        match indices.as_deref() {
            Some(&[a, b, c]) if a != b && b != c && a != c => Ok([a, b, c]),
            _ => Err(format!("face {} of #{} is not a triangle of three distinct, existing vertices", number + 1, face_set.id)),
        }
    }).collect()
}

/// A 1-based index within `1..=len`; an integer, never a truncated real.
fn one_based(item: &AttributeValue, len: usize) -> Option<usize> {
    match item {
        AttributeValue::Integer(value) => usize::try_from(*value).ok().filter(|index| (1..=len).contains(index)),
        _ => None,
    }
}
