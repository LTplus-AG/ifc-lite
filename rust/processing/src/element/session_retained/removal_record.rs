// SPDX-License-Identifier: MPL-2.0
//! One bounded whole-record admission for every raw/decoded J2 proof read.
//! Framing is not schema: used references/lists/scalars are checked separately.
use super::*;
use super::removal_source::refused;
use super::removal_number::charge;
use ifc_lite_core::parser::{parse_ref, StepListItems, StepRecord};
pub(super) fn read<'a>(decoder: &mut EntityDecoder<'a>, id: u32)
    -> Result<StepRecord<'a>, RetainedExecutionError> {
    charge(1)?;
    let raw = decoder.get_raw_bytes(id).ok_or_else(refused)?;
    if raw.len() > 4096 { return Err(refused()); }
    charge(raw.len() as u64 * 16)?;
    let record = StepRecord::parse_complete(raw).ok_or_else(refused)?;
    if record.id() != Some(id) { return Err(refused()); }
    Ok(record)
}
pub(super) fn reference(decoder: &mut EntityDecoder, id: u32, index: usize)
    -> Result<u32,RetainedExecutionError> {
    parse_ref(read(decoder,id)?.attr(index).ok_or_else(refused)?).ok_or_else(refused)
}
/// Shape membership is a complete list of reference tokens. Validate without
/// allocation before allowing decoded get_list to supply membership authority.
pub(super) fn references(decoder: &mut EntityDecoder, id: u32, index: usize)
    -> Result<(),RetainedExecutionError> {
    let record = read(decoder,id)?;
    let mut items = StepListItems::of_list(record.attr(index).ok_or_else(refused)?).ok_or_else(refused)?;
    for item in items.by_ref() {
        charge(1)?;
        parse_ref(item).ok_or_else(refused)?;
    }
    if !items.fully_consumed() { return Err(refused()); }
    Ok(())
}
/// Representation identifiers influence Body selection, so their complete
/// string token must be checked even though other unused metadata stays opaque.
pub(super) fn optional_text(decoder: &mut EntityDecoder, id: u32, index: usize)
    -> Result<(),RetainedExecutionError> {
    let record = read(decoder,id)?;
    let token = record.attr(index).ok_or_else(refused)?;
    if token != b"$" && !(token.first() == Some(&b'\'')
        && ifc_lite_core::step_encoding::step_string_literal_end(token,0) == Some(token.len())) {
        return Err(refused());
    }
    Ok(())
}
