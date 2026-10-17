// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one index rule for tessellated face sets, and the raw-byte reading of
//! a `CoordIndex` that applies it (#7689).
//!
//! `IfcTriangulatedFaceSet.CoordIndex` is `LIST [1:?] OF LIST [3:3] OF
//! IfcPositiveInteger`; `PnIndex` and `IfcIndexedPolygonalFace.CoordIndex`
//! are lists of the same `IfcPositiveInteger`. One rule converts each value
//! ([`ifc_index_to_zero_based`]): an INTEGER in `1..=u32::MAX` is 1-based and
//! becomes `value - 1`; `0`, a negative value, a value past `u32::MAX` and a
//! REAL are not indices. The decoded reading
//! (`AttributeValue::parse_index_list`) and the byte reading here both apply
//! it, and both read a triangle that is not exactly three entries as one
//! dropped slot, so a short or long face never shifts the faces after it.
//!
//! The byte reading is only an accelerator for the decoded one. Where the
//! text is anything but digits, commas, parentheses and trivia (a sign, a
//! REAL, a `$`, a nested list where an index belongs) it answers `None` and
//! the caller decodes the record instead, so the two cannot disagree on
//! malformed input: the byte reading never decides a case it does not share.

use crate::parser::skip_step_trivia;

/// The slot value of an index that fails the rule. Every consumer
/// bounds-checks (`index >= vertex_count`) and drops the triangle, so a
/// slot keeps its position (for parallel `TexCoordIndex` / `ColourIndex`
/// lists) without ever naming a real vertex.
pub const INVALID_INDEX: u32 = u32::MAX;

/// The one rule for a 1-based IFC index (`IfcPositiveInteger`): its 0-based
/// position, or `None` for `0`, a negative value or one past `u32::MAX`.
#[inline]
pub(crate) fn ifc_index_to_zero_based(one_based: i64) -> Option<u32> {
    u32::try_from(one_based).ok().and_then(|v| v.checked_sub(1))
}

/// Read a `CoordIndex` list value (`((1,2,3),(2,1,4),...)`, trivia allowed
/// anywhere) as flat 0-based triangle corners, three per face, with
/// [`INVALID_INDEX`] for values that fail the rule and for all three corners
/// of a face that is not exactly three entries long.
///
/// `None` when the text holds anything the decoded reading must settle (see
/// the module doc), including an unterminated comment or a list that never
/// closes.
pub(super) fn read_coord_index(bytes: &[u8]) -> Option<Vec<u32>> {
    let mut out = Vec::with_capacity(super::estimate_int_count(bytes));
    let mut pos = skip_step_trivia(bytes, 0)?;
    if bytes.get(pos) != Some(&b'(') {
        return None;
    }
    pos = skip_step_trivia(bytes, pos + 1)?;
    if bytes.get(pos) == Some(&b')') {
        return ends_here(bytes, pos + 1).then_some(out);
    }
    loop {
        if bytes.get(pos) != Some(&b'(') {
            return None;
        }
        pos = skip_step_trivia(bytes, pos + 1)?;
        let mut face = [INVALID_INDEX; 3];
        let mut count = 0usize;
        if bytes.get(pos) != Some(&b')') {
            loop {
                let (value, next) = read_index(bytes, pos)?;
                if let Some(slot) = face.get_mut(count) {
                    *slot = value;
                }
                count += 1;
                pos = skip_step_trivia(bytes, next)?;
                match *bytes.get(pos)? {
                    b',' => pos = skip_step_trivia(bytes, pos + 1)?,
                    b')' => break,
                    _ => return None,
                }
            }
        }
        if count != 3 {
            face = [INVALID_INDEX; 3];
        }
        out.extend_from_slice(&face);
        pos = skip_step_trivia(bytes, pos + 1)?;
        match *bytes.get(pos)? {
            b',' => pos = skip_step_trivia(bytes, pos + 1)?,
            b')' => return ends_here(bytes, pos + 1).then_some(out),
            _ => return None,
        }
    }
}

/// Only trivia follows the list.
#[inline]
fn ends_here(bytes: &[u8], pos: usize) -> bool {
    skip_step_trivia(bytes, pos) == Some(bytes.len())
}

/// The unsigned digit run at `pos` under the index rule, and the position
/// after it. `None` when no digit starts there (a sign, `$`, `(`, ...) or
/// the run is past `i64::MAX`, where the tokenizer, not this rule, decides.
#[inline]
fn read_index(bytes: &[u8], mut pos: usize) -> Option<(u32, usize)> {
    let start = pos;
    let mut value: i64 = 0;
    while let Some(&b) = bytes.get(pos).filter(|b| b.is_ascii_digit()) {
        value = value.checked_mul(10)?.checked_add(i64::from(b - b'0'))?;
        pos += 1;
    }
    if pos == start {
        return None;
    }
    Some((ifc_index_to_zero_based(value).unwrap_or(INVALID_INDEX), pos))
}
