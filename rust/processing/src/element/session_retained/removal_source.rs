// SPDX-License-Identifier: MPL-2.0
//! Closed, source-only containment domain: axis-aligned rectangular extrusions
//! in a common authored frame. No mesh/AABB approximation of a general solid.
use super::*;
use ifc_lite_core::{slot, DecodedEntity, IfcType};
use ifc_lite_geometry::placement::Axis2Placement;

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
fn translation(d: &mut EntityDecoder, id: u32) -> Result<[f64; 3], RetainedExecutionError> {
    charge(1)?;
    let placement = Axis2Placement::read_id(id, d).map_err(|_| refused())?;
    // Check raw directions as well: malformed axes must not be normalized into permission.
    if placement.axis.is_some_and(|axis| axis != [0., 0., 1.])
        || placement.ref_direction.is_some_and(|axis| axis != [1., 0., 0.]) {
        return Err(refused());
    }
    if placement.location.iter().any(|x| !x.is_finite()) { return Err(refused()); }
    Ok(placement.location)
}
#[derive(PartialEq)]
struct BoxSource { origin: [f64; 3], centre: [f64; 3], dims: [f64; 3] }
fn prism(d: &mut EntityDecoder, id: u32) -> Result<BoxSource, RetainedExecutionError> {
    let solid = decode(d, id)?;
    if solid.ifc_type != IfcType::IfcExtrudedAreaSolid { return Err(refused()); }
    let profile = decode(d, reference(&solid, 0)?)?;
    if profile.ifc_type != IfcType::IfcRectangleProfileDef || profile.get(0).and_then(ifc_lite_core::AttributeValue::as_enum) != Some("AREA") {
        return Err(refused());
    }
    if d.direction3(reference(&solid, 2)?).map_err(|_| refused())? != [0.,0.,1.] { return Err(refused()); }
    let dims = [profile.get_float(3), profile.get_float(4), solid.get_float(3)];
    let dims = dims.map(|v| v.unwrap_or(f64::NAN));
    if dims.iter().any(|v| !v.is_finite() || *v <= 0.) { return Err(refused()); }
    Ok(BoxSource { origin: translation(d, reference(&solid, 1)?)?,
        centre: translation(d, reference(&profile, 2)?)?, dims })
}
/// Outward interval arithmetic, no tolerance. Equality of identical source
/// coefficients is exact; otherwise require containment even after rounding
/// uncertainty is expanded. This may refuse a marginal but valid removal.
pub(super) fn covers(d: &mut EntityDecoder, host: u32, cutter: u32) -> Result<bool, RetainedExecutionError> {
    let host = prism(d, host)?;
    let cutter = prism(d, cutter)?;
    if host == cutter { return Ok(true); }
    let endpoint = |b: &BoxSource, axis: usize, upper: bool| {
        let centre = b.origin[axis] + b.centre[axis];
        let extent = if axis == 2 { if upper { b.dims[axis] } else { 0. } }
            else if upper { b.dims[axis] / 2. } else { -b.dims[axis] / 2. };
        ((centre.next_down() + extent.next_down()).next_down(),
         (centre.next_up() + extent.next_up()).next_up())
    };
    Ok((0..3).all(|axis| {
        let hmin = endpoint(&host, axis, false); let hmax = endpoint(&host, axis, true);
        let cmin = endpoint(&cutter, axis, false); let cmax = endpoint(&cutter, axis, true);
        [hmin.0,hmax.1,cmin.1,cmax.0].iter().all(|v| v.is_finite())
            && cmin.1 <= hmin.0 && cmax.0 >= hmax.1
    }))
}
