// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Eligibility for occurrence-local evaluated Body replacement (#4404).
use super::{source::{refs, Source}, *};
use ifc_lite_core::DecodedEntity;

pub(super) fn body(source: &mut Source<'_>, product_id: u32) -> Result<(DecodedEntity, DecodedEntity), String> {
    let product = source.entity(product_id)?;
    if !product.ifc_type.is_subtype_of(IfcType::IfcElement)
        || product.ifc_type.name().ends_with("StandardCase")
        || product.ifc_type.is_subtype_of(IfcType::IfcFeatureElement) {
        return Err("Evaluated appearance requires an element whose IFC class permits tessellation".into());
    }
    source.validate_world_placement(&product)?;
    let pds_id = product.get_ref(6).ok_or("Product has no representation")?;
    let pds = source.entity(pds_id)?;
    if pds.ifc_type != IfcType::IfcProductDefinitionShape || !source.single_parent(pds_id, product_id) {
        return Err("Evaluated appearance requires an occurrence-owned ProductDefinitionShape".into());
    }
    let mut found = None;
    for id in refs(pds.get(2))? {
        let rep = source.entity(id)?;
        if rep.ifc_type != IfcType::IfcShapeRepresentation { return Err("Unsupported product representation".into()); }
        if !rep.get_string(1).is_some_and(|s| s.eq_ignore_ascii_case("Body")) {
            if !matches!(rep.get_string(2), Some("BoundingBox" | "Curve2D" | "Curve3D" | "GeometricCurveSet")) {
                return Err("Additional renderable representations are unsupported for evaluated appearance".into());
            }
            continue;
        }
        if found.is_some() { return Err("Evaluated appearance requires exactly one Body representation".into()); }
        if !source.incoming.get(&id).is_some_and(|incoming| incoming.contains(&pds_id)
            && incoming.iter().all(|parent| *parent == pds_id || source.types.get(parent) == Some(&IfcType::IfcPresentationLayerAssignment))) {
            return Err("Body is shared or has unsupported layer/aspect associations".into());
        }
        if rep.get_string(2) != Some("MappedRepresentation") {
            return Err("Evaluated appearance currently supports mapped occurrence bodies only".into());
        }
        found = Some(rep);
    }
    Ok((product, found.ok_or("No occurrence Body representation")?))
}

/// Flatten only the schema's single assignment wrapper, never a recursive file
/// graph. Preserve the existing surface style definition rather than its RGB.
pub(super) fn surface_styles(source: &mut Source<'_>, item: u32) -> Result<Vec<u32>, String> {
    let styled = source.styled_items.get(&item).cloned().unwrap_or_default();
    if styled.len() != 1 { return Err("Evaluated appearance requires one explicit source surface style".into()); }
    let entity = source.entity(styled[0])?;
    let direct = refs(entity.get(1))?;
    if direct.len() > 8 { return Err("Source style assignment exceeds its budget".into()); }
    let mut result = Vec::new();
    for id in direct {
        let style = source.entity(id)?;
        let ids = if source.style_assignments.contains(&id) { refs(style.get(0))? } else { vec![id] };
        if ids.len() > 8 { return Err("Source style assignment exceeds its budget".into()); }
        for id in ids {
            if source.types.get(&id) != Some(&IfcType::IfcSurfaceStyle) { return Err("Source has unsupported non-surface styles".into()); }
            result.push(id);
        }
    }
    if result.len() != 1 { return Err("Multiple or missing source surface styles are unsupported".into()); }
    let surface = source.entity(result[0])?;
    let members=refs(surface.get(2))?;
    if members.len()>5 { return Err("Surface style exceeds its schema budget".into()); }
    for id in members {
        if source.types.get(&id) == Some(&IfcType::IfcSurfaceStyleWithTextures) {
            return Err("Evaluated conversion of existing texture coordinates is not supported".into());
        }
    }
    Ok(result)
}

pub(super) fn local_points(source: &mut Source<'_>, product: &DecodedEntity,
    mesh: &crate::types::mesh::MeshData) -> Result<Vec<[f64; 3]>, String> {
    let scale = source.decoder.length_unit_scale();
    let context = source.context.as_ref().ok_or("Missing canonical context")?;
    // Resolve placement without RTC: mesh origin and context RTC are restored
    // before applying the inverse product frame, in IFC metres exactly once.
    let transform = ifc_lite_geometry::GeometryRouter::with_scale(scale)
        .resolve_scaled_placement(product, &mut source.decoder).map_err(|e| e.to_string())?;
    let columns: [[f64;3];3] = std::array::from_fn(|i| std::array::from_fn(|j| transform[i*4+j]));
    let dot = |a:[f64;3], b:[f64;3]| a.iter().zip(b).map(|(a,b)| a*b).sum::<f64>();
    if !scale.is_finite() || scale <= 0. || transform.iter().any(|v| !v.is_finite())
        || (0..3).any(|i| (0..3).any(|j| (dot(columns[i], columns[j]) - if i==j {1.} else {0.}).abs()>1e-10)) {
        return Err("Evaluated appearance requires a finite rigid product placement".into());
    }
    let rtc: [f64;3] = if context.meta.needs_shift { context.meta.rtc_offset.into() } else { [0.;3] };
    mesh.positions.chunks_exact(3).map(|p| {
        let delta = std::array::from_fn(|i| f64::from(p[i])+mesh.origin[i]+rtc[i]-transform[12+i]);
        let point = columns.map(|axis| dot(axis,delta)/scale);
        if point.iter().any(|v| !v.is_finite()) { Err("Evaluated coordinate exceeds numeric range".into()) } else { Ok(point) }
    }).collect()
}
