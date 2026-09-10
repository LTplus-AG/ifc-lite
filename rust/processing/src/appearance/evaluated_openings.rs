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
    for opening in openings {
        let element = source.entity(opening)?;
        if !element.ifc_type.is_subtype_of(IfcType::IfcOpeningElement) { return Ok(false); }
        let pds = source.entity(element.get_ref(6).ok_or("Opening has no representation")?)?;
        if pds.ifc_type != IfcType::IfcProductDefinitionShape { return Ok(false); }
        let representations = refs(pds.get(2))?;
        if representations.is_empty() || representations.len() > 8 { return Ok(false); }
        let mut reference = false;
        for id in representations {
            let representation = source.entity(id)?;
            if representation.ifc_type != IfcType::IfcShapeRepresentation { return Ok(false); }
            if representation.get_string(1).is_some_and(|name| name.eq_ignore_ascii_case("Reference")) {
                reference = true;
            } else if representation.get_string(2) != Some("BoundingBox") {
                // Unknown/mixed Body geometry remains subtractive or ambiguous.
                return Ok(false);
            }
        }
        if !reference { return Ok(false); }
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
