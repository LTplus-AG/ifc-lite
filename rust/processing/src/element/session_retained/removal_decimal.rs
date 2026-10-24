// SPDX-License-Identifier: MPL-2.0
//! Source-authorized lexical records, using the same StepRecord/StepListItems
//! and numeric grammar primitives as #3641. No decoded float is proof authority.
use super::*;
use super::removal_source::refused;
use super::removal_number::{add, charge, decimal, ONE};
use ifc_lite_core::parser::{parse_ref, StepListItems, StepRecord};

fn record<'a>(d: &mut EntityDecoder<'a>, id: u32, keyword: Option<&[u8]>, count: usize)
    -> Result<StepRecord<'a>, RetainedExecutionError> {
    charge(1)?;
    let raw = d.get_raw_bytes(id).ok_or_else(refused)?;
    if raw.len() > 4096 { return Err(refused()); }
    charge(raw.len() as u64 * 16)?;
    let record = StepRecord::parse(raw).ok_or_else(refused)?;
    if record.id() != Some(id) || keyword.is_some_and(|k| !record.keyword_is(k)) { return Err(refused()); }
    let mut attrs = record.attrs();
    for _ in 0..count { attrs.next().ok_or_else(refused)?; }
    if attrs.next().is_some() || !attrs.closed() { return Err(refused()); }
    Ok(record)
}
fn reference(value: Option<&[u8]>) -> Result<u32, RetainedExecutionError> {
    parse_ref(value.ok_or_else(refused)?).ok_or_else(refused)
}
fn vector(d: &mut EntityDecoder, id: u32, direction: bool, dimensions: usize)
    -> Result<[i128;3], RetainedExecutionError> {
    let keyword = if direction { b"IFCDIRECTION".as_slice() } else { b"IFCCARTESIANPOINT".as_slice() };
    let r = record(d,id,Some(keyword),1)?;
    let mut items = StepListItems::of_list(r.attr(0).ok_or_else(refused)?).ok_or_else(refused)?;
    let mut result = [0;3];
    for value in result.iter_mut().take(dimensions) { *value = decimal(items.next().ok_or_else(refused)?)?; }
    if items.next().is_some() || !items.closed() { return Err(refused()); }
    Ok(result)
}
fn axis(d: &mut EntityDecoder, token: Option<&[u8]>, dimensions: usize, expected: [i128;3])
    -> Result<(), RetainedExecutionError> {
    // Only an explicit $ is the EXPRESS default. Missing/*/wrong refs refuse.
    if token == Some(b"$") { return Ok(()); }
    if vector(d,reference(token)?,true,dimensions)? != expected { return Err(refused()); }
    Ok(())
}
fn translation(d: &mut EntityDecoder, id: u32, planar: bool) -> Result<[i128;3], RetainedExecutionError> {
    let (keyword, count, dimensions) = if planar { (b"IFCAXIS2PLACEMENT2D".as_slice(),2,2) }
        else { (b"IFCAXIS2PLACEMENT3D".as_slice(),3,3) };
    let r = record(d,id,Some(keyword),count)?;
    if !planar { axis(d,r.attr(1),3,[0,0,ONE])?; }
    axis(d,r.attr(if planar {1} else {2}),dimensions,[ONE,0,0])?;
    vector(d,reference(r.attr(0))?,false,dimensions)
}
#[derive(PartialEq)]
pub(super) struct BoxSource {
    pub origin: [i128;3], pub centre: [i128;3], pub dims: [i128;3],
}
pub(super) fn prism(d: &mut EntityDecoder, id: u32) -> Result<BoxSource, RetainedExecutionError> {
    let solid = record(d,id,Some(b"IFCEXTRUDEDAREASOLID"),4)?;
    let profile = record(d,reference(solid.attr(0))?,Some(b"IFCRECTANGLEPROFILEDEF"),5)?;
    if !profile.attr(0).is_some_and(|v| v.eq_ignore_ascii_case(b".AREA.")) { return Err(refused()); }
    let name = profile.attr(1).ok_or_else(refused)?;
    if name != b"$" && !(name.first() == Some(&b'\'')
        && ifc_lite_core::step_encoding::step_string_literal_end(name,0) == Some(name.len())) { return Err(refused()); }
    // ExtrudedDirection is mandatory, so $ cannot default here.
    if vector(d,reference(solid.attr(2))?,true,3)? != [0,0,ONE] { return Err(refused()); }
    let dims = [decimal(profile.attr(3).ok_or_else(refused)?)?,decimal(profile.attr(4).ok_or_else(refused)?)?,
        decimal(solid.attr(3).ok_or_else(refused)?)?];
    if dims.iter().any(|v| *v <= 0) { return Err(refused()); }
    let centre = if profile.attr(2) == Some(b"$") { [0;3] }
        else { translation(d,reference(profile.attr(2))?,true)? };
    Ok(BoxSource { origin: translation(d,reference(solid.attr(1))?,false)?, centre, dims })
}
fn product_translation(d: &mut EntityDecoder, product: u32) -> Result<[i128;3], RetainedExecutionError> {
    // Product identity/type is admitted by the common source traversal. Raw
    // record identity and full closure still precede reading ObjectPlacement.
    charge(1)?;
    let raw = d.get_raw_bytes(product).ok_or_else(refused)?;
    if raw.len() > 4096 { return Err(refused()); }
    charge(raw.len() as u64 * 16)?;
    let r = StepRecord::parse(raw).ok_or_else(refused)?;
    if r.id() != Some(product) { return Err(refused()); }
    let mut attrs = r.attrs();
    let mut count = 0;
    while attrs.next().is_some() { count += 1; if count > 16 { return Err(refused()); } }
    if !attrs.closed() || count < 6 { return Err(refused()); }
    let mut cursor = r.attr(5).ok_or_else(refused)?;
    let mut seen = [0u32;64];
    let mut used = 0;
    let mut total = [0i128;3];
    while cursor != b"$" {
        // Fixed stack and bounded iterative chain; charge before source access.
        charge(64)?;
        if used == seen.len() { return Err(refused()); }
        let id = reference(Some(cursor))?;
        if seen[..used].contains(&id) { return Err(refused()); }
        seen[used] = id; used += 1;
        let placement = record(d,id,Some(b"IFCLOCALPLACEMENT"),2)?;
        let offset = translation(d,reference(placement.attr(1))?,false)?;
        for i in 0..3 { total[i] = add(total[i],offset[i])?; }
        cursor = placement.attr(0).ok_or_else(refused)?;
    }
    Ok(total)
}
pub(super) fn coframed(d: &mut EntityDecoder, host: u32, opening: u32) -> Result<bool, RetainedExecutionError> {
    let host = product_translation(d,host)?;
    let opening = product_translation(d,opening)?;
    Ok(host == opening)
}
