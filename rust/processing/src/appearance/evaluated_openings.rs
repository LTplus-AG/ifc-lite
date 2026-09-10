// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Bounded, conservative opening representation eligibility for appearance.
use super::source::{refs, Source};
use ifc_lite_core::IfcType;

/// A direct tessellation can already include its cuts. Reference-only opening
/// geometry is semantic documentation and must not make that surface ineligible
/// for a later appearance operation. Do not infer this from RepresentationType:
/// a Reference may still describe SweptSolid geometry.
pub(super) fn reference_only(source: &mut Source<'_>, product: u32) -> Result<bool, String> {
    let incoming = source.incoming.get(&product).cloned().unwrap_or_default();
    // Until the caller supplies the complete propagated void inventory, an
    // aggregate association could add subtractive openings from an ancestor.
    if incoming.iter().any(|id| source.types.get(id) == Some(&IfcType::IfcRelAggregates)) {
        return Ok(false);
    }
    let mut openings = Vec::new();
    for id in incoming {
        if source.types.get(&id) != Some(&IfcType::IfcRelVoidsElement) { continue; }
        let relation = source.entity(id)?;
        if relation.get_ref(4) == Some(product) {
            openings.push(relation.get_ref(5).ok_or("Opening relationship has no related opening")?);
            if openings.len() > 64 { return Err("Appearance opening scope exceeds 64 openings".into()); }
        }
    }
    if openings.is_empty() { return Ok(false); }
    let router=source.context.as_ref().ok_or("Missing canonical context")?.router();
    for opening in openings {
        if router.opening_requires_subtraction(opening,&mut source.decoder) {return Ok(false);}
    }
    Ok(true)
}

/// Freeze the opening representation edits before evaluating or mutating a
/// host. An opening used by another canonical host cannot change semantics as a
/// side effect of this occurrence's conversion.
pub(super) fn prepare(
    source: &mut Source<'_>, product: u32,
    opening_ids: &[u32], exclusive: &std::collections::BTreeSet<u32>,
) -> Result<Vec<ifc_lite_core::DecodedEntity>, String> {
    if opening_ids.is_empty() { return Ok(Vec::new()); }
    if opening_ids.len() > 64 { return Err("Appearance opening scope exceeds 64 openings".into()); }
    if source.incoming.get(&product).is_some_and(|parents| parents.iter()
        .any(|id| source.types.get(id) == Some(&IfcType::IfcRelAggregates))) {
        return Err("Evaluated conversion of aggregate opening-bearing products is unsupported".into());
    }
    let mut result = Vec::new();
    for &id in opening_ids {
        if !exclusive.contains(&id) { return Err("Opening affects another canonical host".into()); }
        let opening = source.entity(id)?;
        if !opening.ifc_type.is_subtype_of(IfcType::IfcOpeningElement) { return Err("Unsupported opening class".into()); }
        let pds_id = opening.get_ref(6).ok_or("Opening has no representation")?;
        if !source.single_parent(pds_id, id) { return Err("Opening ProductDefinitionShape is shared".into()); }
        let pds = source.entity(pds_id)?;
        if pds.ifc_type != IfcType::IfcProductDefinitionShape { return Err("Unsupported opening representation".into()); }
        let representations = refs(pds.get(2))?;
        if representations.is_empty() || representations.len() > 8 { return Err("Opening representation scope is empty or exceeds its budget".into()); }
        let mut found = false;
        for rep_id in representations {
            let rep = source.entity(rep_id)?;
            if rep.ifc_type != IfcType::IfcShapeRepresentation { return Err("Unsupported opening shape".into()); }
            match rep.get_string(1) {
                Some(name) if name.eq_ignore_ascii_case("Reference") => found = true,
                Some(name) if name.eq_ignore_ascii_case("Body") => {
                    if !source.single_parent(rep_id, pds_id) { return Err("Opening Body has shared or unsupported associations".into()); }
                    found = true;
                    result.push(rep);
                }
                _ if rep.get_string(2) == Some("BoundingBox") => {},
                _ => return Err("Opening has ambiguous non-Body geometry".into()),
            }
        }
        if !found { return Err("Opening has no supported Body or Reference geometry".into()); }
    }
    Ok(result)
}

/// Capture companion geometry through the same evaluator before its rows change.
/// Textured companions remain refused until publication can retain their assets.
pub(super) fn removed_meshes(
    source: &mut Source<'_>, opening_ids: &[u32], edits: &[ifc_lite_core::DecodedEntity],
    textures: &rustc_hash::FxHashMap<u32, ifc_lite_geometry::ResolvedTextureMap>,
    styles: &crate::prepass::ResolvedPrepass, budget: &mut super::budget::PlanBudget,
) -> Result<Vec<crate::types::mesh::MeshData>, String> {
    let edited: std::collections::BTreeSet<_> = edits.iter().map(|row| row.id).collect();
    let mut result = Vec::new();
    for &owner in opening_ids {
        let opening = source.entity(owner)?;
        let pds = source.entity(opening.get_ref(6).ok_or("Missing opening representation")?)?;
        if !refs(pds.get(2))?.iter().any(|id| edited.contains(id)) { continue; }
        for mesh in super::canonical::produce(source, owner, textures, Some(styles))? {
            if mesh.express_id != owner || mesh.geometry_item_id.is_none()
                || mesh.positions.is_empty() || mesh.positions.len() % 3 != 0
                || mesh.normals.len() != mesh.positions.len()
                || mesh.indices.is_empty() || mesh.indices.len() % 3 != 0
                || mesh.positions.iter().chain(&mesh.normals).chain(&mesh.color).any(|v| !v.is_finite())
                || mesh.origin.iter().any(|v| !v.is_finite())
                || mesh.indices.iter().any(|&i| i as usize >= mesh.positions.len() / 3) {
                return Err("Canonical opening companion geometry is invalid".into());
            }
            if mesh.texture.is_some() || mesh.uvs.is_some() {
                return Err("Conversion of textured opening companions is unsupported".into());
            }
            budget.reserve(mesh.positions.len() / 3, mesh.indices.len() / 3, 0)?;
            result.push(mesh);
        }
    }
    Ok(result)
}
