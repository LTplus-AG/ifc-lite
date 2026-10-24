// SPDX-License-Identifier: MPL-2.0
//! Closed, source-only containment domain: axis-aligned rectangular extrusions
//! in a common authored frame. No mesh/AABB approximation of a general solid.
use super::*;
use ifc_lite_core::{slot, DecodedEntity, IfcType};
use super::removal_decimal::{prism, BoxSource};
use super::removal_number::endpoint;

pub(super) fn refused() -> RetainedExecutionError {
    RetainedExecutionError::Unsupported("opening removal protection policy: source containment unproved")
}
fn charge(work: usize) -> Result<(), RetainedExecutionError> {
    resource::charge(resource::Cost { work: work as u64, ..Default::default() })
        .map_err(RetainedExecutionError::Stopped)?.retain();
    Ok(())
}
fn decode(d: &mut EntityDecoder, id: u32) -> Result<DecodedEntity, RetainedExecutionError> {
    charge(1)?;
    d.decode_by_id(id).map_err(|_| RetainedExecutionError::Source)
}
fn reference(e: &DecodedEntity, index: usize) -> Result<u32, RetainedExecutionError> {
    e.get_ref(index).ok_or(RetainedExecutionError::Source)
}
/// Only direct Body items: mappings/CSG require a different containment proof.
pub(super) fn body(d: &mut EntityDecoder, product: u32) -> Result<Vec<u32>, RetainedExecutionError> {
    let product = decode(d, product)?;
    let shape = decode(d, reference(&product, slot::IfcProduct::REPRESENTATION.index())?)?;
    if shape.ifc_type != IfcType::IfcProductDefinitionShape { return Err(refused()); }
    let reps = shape.get_list(2).ok_or_else(refused)?;
    charge(reps.len())?;
    let mut selected = None;
    for member in reps {
        let rep = decode(d, member.as_entity_ref().ok_or_else(refused)?)?;
        if !matches!(rep.ifc_type, IfcType::IfcShapeRepresentation | IfcType::IfcTopologyRepresentation) {
            return Err(refused());
        }
        if rep.get_string(1) != Some("Body") { continue; }
        if selected.is_some() { return Err(refused()); }
        let items = rep.get_list(3).ok_or_else(refused)?;
        charge(items.len())?;
        let mut ids = Vec::new();
        OwnedResourceContext::capture_current().reserve_headers(&mut ids, items.len())
            .map_err(RetainedExecutionError::Stopped)?.retain();
        for item in items { ids.push(item.as_entity_ref().ok_or_else(refused)?); }
        selected = Some(ids);
    }
    selected.filter(|ids| !ids.is_empty()).ok_or_else(refused)
}
/// Authenticate caller-supplied void index against actual source relationships.
/// This reads relation records, never unreachable opening bodies.
pub(super) fn relationships(context: &OwnedMeshProductionContext, d: &mut EntityDecoder, product: u32)
    -> Result<Vec<u32>, RetainedExecutionError> {
    let source = context.source().ok_or(RetainedExecutionError::Source)?;
    charge(source.bytes().len().div_ceil(4096))?;
    let mut scanner = ifc_lite_core::EntityScanner::new(source.bytes());
    let mut ids = Vec::new();
    while let Some((id, name, _, _)) = scanner.next_entity() {
        if !ifc_lite_core::keyword_eq(name, "IFCRELVOIDSELEMENT") { continue; }
        let relation = decode(d, id)?;
        if relation.ifc_type != IfcType::IfcRelVoidsElement { return Err(refused()); }
        if reference(&relation, 4)? != product { continue; }
        OwnedResourceContext::capture_current().reserve_headers(&mut ids, 1)
            .map_err(RetainedExecutionError::Stopped)?.retain();
        ids.push(reference(&relation, 5)?);
    }
    if context.borrowed().void_index.get(&product).map(Vec::as_slice).unwrap_or(&[]) != ids.as_slice() {
        return Err(RetainedExecutionError::Source);
    }
    Ok(ids)
}
/// Exact bounded authored-decimal arithmetic. Never compare decoded floats.
pub(super) fn covers(d: &mut EntityDecoder, host: u32, cutter: u32) -> Result<bool, RetainedExecutionError> {
    let host = prism(d, host)?;
    let cutter = prism(d, cutter)?;
    charge(64)?;
    if host == cutter { return Ok(true); }
    let bounds = |b: &BoxSource| -> Result<[(i128,i128);3], RetainedExecutionError> {
        let mut result = [(0,0);3];
        for (axis, pair) in result.iter_mut().enumerate() {
            let lower = if axis == 2 { 0 } else { -b.dims[axis] };
            let upper = if axis == 2 { b.dims[axis].checked_mul(2).ok_or_else(refused)? } else { b.dims[axis] };
            *pair = (endpoint(b.origin[axis],b.centre[axis],lower)?,endpoint(b.origin[axis],b.centre[axis],upper)?);
        }
        Ok(result)
    };
    let host = bounds(&host)?;
    let cutter = bounds(&cutter)?;
    Ok((0..3).all(|axis| {
        cutter[axis].0 <= host[axis].0 && cutter[axis].1 >= host[axis].1
    }))
}
