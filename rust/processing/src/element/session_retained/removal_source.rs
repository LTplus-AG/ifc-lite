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
    super::removal_record::read(d,id)?;
    d.decode_by_id(id).map_err(|_| RetainedExecutionError::Source)
}
/// Only direct Body items: mappings/CSG require a different containment proof.
pub(super) fn body(d: &mut EntityDecoder, product: u32) -> Result<Vec<u32>, RetainedExecutionError> {
    let shape_id = super::removal_record::reference(d, product, slot::IfcProduct::REPRESENTATION.index())?;
    super::removal_record::references(d,shape_id,2)?;
    let shape = decode(d, shape_id)?;
    if shape.ifc_type != IfcType::IfcProductDefinitionShape { return Err(refused()); }
    let reps = shape.get_list(2).ok_or_else(refused)?;
    charge(reps.len())?;
    let mut selected = None;
    for member in reps {
        let rep_id = member.as_entity_ref().ok_or_else(refused)?;
        super::removal_record::optional_text(d,rep_id,1)?;
        super::removal_record::references(d,rep_id,3)?;
        let rep = decode(d, rep_id)?;
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
        let host_id = super::removal_record::reference(d,id,4)?;
        let opening_id = super::removal_record::reference(d,id,5)?;
        let relation = decode(d, id)?;
        if relation.ifc_type != IfcType::IfcRelVoidsElement { return Err(refused()); }
        if host_id != product { continue; }
        OwnedResourceContext::capture_current().reserve_headers(&mut ids, 1)
            .map_err(RetainedExecutionError::Stopped)?.retain();
        ids.push(opening_id);
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
