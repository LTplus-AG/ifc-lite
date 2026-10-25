// SPDX-License-Identifier: MPL-2.0
//! Export-only section cuts. Source products and semantic relationships are never retyped.

use std::collections::BTreeMap;
use ifc_lite_core::{slot, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::math::v3;
use ifc_lite_geometry::kernel::arrangement::Tri;
use ifc_lite_processing::{process, ProcessingRequest, MeshData, MeshFrame};
#[cfg(test)]
use ifc_lite_processing::process_geometry;
use ifc_lite_processing::element::GEOM_CLASS_LAYER_SLICE;
use serde::{Deserialize, Serialize};

#[path = "section_clip_mesh.rs"]
mod mesh;
#[path = "section_clip_parts.rs"]
mod parts;
#[path = "section_clip_safety.rs"]
mod safety;

/// Kept half-space `normal · world <= offset`, IFC Z-up, metres.
#[derive(Clone, Debug, Deserialize)]
pub struct SectionExportPlane {
    pub normal: [f64; 3],
    pub offset: f64,
}

/// Replacement surface part, in the original product placement frame, IFC Z-up FILE units.
#[derive(Debug, Serialize)]
pub struct SectionExportPart {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    pub color: [f32; 4],
    pub closed: bool,
    #[serde(rename = "faceColors", skip_serializing_if = "Vec::is_empty")]
    pub face_colors: Vec<[f32; 4]>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionExportElement {
    pub express_id: u32,
    pub parts: Vec<SectionExportPart>,
}

/// An atomic, temporary export overlay. A failed cut returns Err, never full geometry.
#[derive(Debug, Default, Serialize)]
pub struct SectionExportPlan {
    pub replacements: Vec<SectionExportElement>,
    pub outside: Vec<u32>,
}

/// Plan section geometry against the completed, mutation-resolved STEP source.
/// `trim=false` retains crossing elements whole; fully excluded elements still go.
/// The normal loader supplies geometry, opening cuts, units, colors and RTC frame.
pub fn plan_section_export(
    content: &[u8], planes: &[SectionExportPlane], trim: bool,
) -> Result<SectionExportPlan, String> {
    if planes.len() > 32 { return Err("section export supports at most 32 planes".into()); }
    let planes = planes.iter().map(|plane| {
        let length = v3::norm(plane.normal);
        if !length.is_finite() || length <= 0.0 || !plane.offset.is_finite() {
            return Err("section export requires finite, nonzero planes".to_string());
        }
        let normalized = SectionExportPlane { normal: plane.normal.map(|v| v / length), offset: plane.offset / length };
        if !normalized.offset.is_finite() { return Err("section offset overflows during normalization".into()); }
        Ok(normalized)
    }).collect::<Result<Vec<_>, String>>()?;
    if planes.is_empty() { return Ok(SectionExportPlan::default()); }
    let mut safety = safety::Safety::default();
    let processed = process(content, &ProcessingRequest::full_pass(), &mut safety);
    let mut groups = BTreeMap::<u32, Vec<&MeshData>>::new();
    for part in &processed.meshes {
        if !matches!(part.geometry_class, 0 | GEOM_CLASS_LAYER_SLICE) {
            return Err(format!("section export cannot safely crop geometry class {} for #{}", part.geometry_class, part.express_id));
        }
        groups.entry(part.express_id).or_default().push(part);
    }
    // Refuse unmeshed physical products: otherwise a successful crop could leak
    // source geometry the processor could not classify. Spatial/symbolic records
    // remain with the existing STEP subset closure.
    let mut decoder = EntityDecoder::new(content).with_strict_reals();
    safety.index_attachments(content, &mut decoder)?;
    let mut scanner = EntityScanner::new(content);
    let mut unit = 1.0;
    while let Some((id, name, _, _)) = scanner.next_entity() {
        let kind = IfcType::from_str(name);
        if kind == IfcType::IfcProject {
            unit = ifc_lite_core::try_extract_length_unit_scale(&mut decoder, id)
                .ok_or("section export cannot resolve project length units")?;
        }
        let product_kind = kind.is_subtype_of(IfcType::IfcProduct);
        if product_kind && [IfcType::IfcOpeningElement, IfcType::IfcAnnotation, IfcType::IfcGrid]
            .into_iter().any(|base| kind.is_subtype_of(base)) {
            groups.remove(&id);
            continue;
        }
        if product_kind || ifc_lite_core::has_geometry_by_name(name) {
            let entity = decoder.decode_by_id(id).map_err(|error| error.to_string())?;
            if entity.ref_at(slot::IfcProduct::REPRESENTATION).is_some() && !groups.contains_key(&id) {
                return Err(format!("section export cannot safely crop unmeshed {name} #{id}"));
            }
        }
    }
    if !unit.is_finite() || unit <= 0.0 { return Err("invalid section export length unit".into()); }
    let router = ifc_lite_geometry::GeometryRouter::with_scale(unit);
    let mut plan = SectionExportPlan::default();
    for (id, parts) in groups {
        // Axis-based products can mesh without an IfcProduct Representation.
        // Every retained mesh group still needs the same complete receipt and
        // readable source graph before any inside/outside/crossing decision.
        let textured = safety.require_product(id, &mut decoder, &processed.stats)?;
        let _budget = ifc_lite_geometry::kernel::budget::enter_element();
        let (clipped, changed) = parts::cut_parts(&parts, processed.frame, &planes, trim)
            .map_err(|error| format!("section export #{id}, {error}"))?;
        if clipped.is_empty() { plan.outside.push(id); continue; }
        if !changed || !trim { continue; }
        if textured || parts.iter().any(|part| part.texture.is_some() || part.uvs.is_some()) {
            return Err(format!("section export cannot trim textured product #{id}: texture/UV preservation is unsupported"));
        }
        let product = decoder.decode_by_id(id).map_err(|error| error.to_string())?;
        // A new Body would not replace the authored Axis used on reopen.
        // Refuse before emitting an unwritable or uncropped replacement plan.
        if product.ifc_type == IfcType::IfcAlignment
            && ifc_lite_geometry::locate_axis_curve(&product, &mut decoder).is_some() {
            return Err(format!("section export cannot trim axis-based alignment #{id}: preserving clipped Axis geometry is unsupported; use whole-element mode"));
        }
        let placement = router.resolve_scaled_placement_strict(&product, &mut decoder)
            .map_err(|error| format!("section export cannot resolve placement #{id}: {error}"))?;
        let inverse = nalgebra::Matrix4::from_column_slice(&placement).try_inverse()
            .ok_or_else(|| format!("section export refuses singular placement #{id}"))?;
        let mut replacements = Vec::new();
        for part in clipped {
            let closed = mesh::closed(&part.triangles);
            let mut positions = Vec::with_capacity(part.triangles.len() * 9);
            let mut indices = Vec::with_capacity(part.triangles.len() * 3);
            for triangle in part.triangles {
                for p in triangle {
                    let world = processed.frame.to_world(v3::add(p, part.origin));
                    let local = inverse * nalgebra::Vector4::new(world[0], world[1], world[2], 1.0);
                    positions.extend([local[0] / unit, local[1] / unit, local[2] / unit]);
                    indices.push(indices.len() as u32);
                }
            }
            replacements.push(SectionExportPart { positions, indices, color: part.color, closed, face_colors: part.face_colors });
        }
        plan.replacements.push(SectionExportElement { express_id: id, parts: replacements });
    }
    Ok(plan)
}

fn cut_triangles(
    mut triangles: Vec<Tri>, origin: [f64; 3], frame: MeshFrame, planes: &[SectionExportPlane],
) -> Result<(Vec<Tri>, bool), String> {
    let world_origin = frame.to_world(origin);
    let mut changed = false;
    for plane in planes {
        if triangles.is_empty() { break; }
        let normal = frame.rotate_into_frame(plane.normal);
        let offset = plane.offset - v3::dot(plane.normal, world_origin);
        let (mut inside, mut outside) = (false, false);
        for p in triangles.iter().flatten() {
            if v3::dot(normal, *p) <= offset { inside = true; } else { outside = true; }
        }
        if !outside { continue; }
        changed = true;
        if !inside { triangles.clear(); break; }
        triangles = mesh::cut(&triangles, normal, offset)?;
    }
    Ok((triangles, changed))
}

#[cfg(test)]
#[path = "section_clip_tests.rs"]
mod tests;
