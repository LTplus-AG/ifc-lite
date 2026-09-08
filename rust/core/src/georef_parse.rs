// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Compound-plane-angle parsing helpers for `georef.rs`'s legacy
//! `IfcSite.RefLatitude`/`RefLongitude` fallback.
//!
//! Split out of `georef.rs` to keep that module inside its module-size
//! ratchet budget (matching the `georef_tests.rs` split for test code):
//! these three functions are cohesive (all exist to turn a STEP
//! `IfcCompoundPlaneAngleMeasure` list into signed decimal degrees) and are
//! only ever called from `georef.rs::extract_from_site`.

use crate::schema_gen::DecodedEntity;

/// Convert an `IfcCompoundPlaneAngleMeasure` attribute (list of 3-4
/// integers: degrees, minutes, seconds, optional millionth-seconds) to
/// decimal degrees. Same sign handling as the TS parser: any negative
/// component makes the whole angle negative.
pub(super) fn compound_plane_angle_to_degrees(entity: &DecodedEntity, index: usize) -> Option<f64> {
    let list = entity.get_list(index)?;
    let mut numbers = Vec::with_capacity(4);
    for value in list {
        if let Some(v) = value.as_float() {
            numbers.push(v);
        }
    }
    if numbers.len() < 3 {
        return None;
    }
    let millionths = numbers.get(3).copied().unwrap_or(0.0);
    let sign = if numbers[0] < 0.0 || numbers[1] < 0.0 || numbers[2] < 0.0 || millionths < 0.0 {
        -1.0
    } else {
        1.0
    };
    let degrees = numbers[0].abs();
    let minutes = numbers[1].abs();
    let seconds = numbers[2].abs();
    let millionths = millionths.abs();
    Some(sign * (degrees + minutes / 60.0 + (seconds + millionths / 1_000_000.0) / 3600.0))
}

/// True if any component of the compound-plane-angle list at `attr_index`
/// (0-based, matching `DecodedEntity::get`/`get_list` indexing) is the
/// literal negative-zero integer token `-0` in `bytes` (an entity's raw
/// record, `#N=TYPE(attr0,attr1,...);`).
///
/// This walks the raw bytes rather than re-tokenizing through the shared
/// STEP tokenizer: `-0` reaches `AttributeValue::Integer` as plain `0` (see
/// `compound_plane_angle_to_degrees`'s doc comment above), so by the time an
/// entity is decoded the sign is already gone. Restricted to this one
/// legacy-site attribute pair — not a general-purpose STEP attribute
/// splitter — so it stays correct without having to handle every literal
/// shape the real tokenizer does (typed values, nested lists, comments).
pub(super) fn compound_angle_has_literal_negative_zero(bytes: &[u8], attr_index: usize) -> bool {
    let Some(list_bytes) = nth_top_level_attribute(bytes, attr_index) else {
        return false;
    };
    let trimmed = list_bytes.trim_ascii();
    let Some(inner) = trimmed
        .strip_prefix(b"(")
        .and_then(|b| b.strip_suffix(b")"))
    else {
        return false;
    };
    inner
        .split(|&b| b == b',')
        .any(|component| component.trim_ascii() == b"-0")
}

/// The raw byte span of the `attr_index`-th (0-based) top-level attribute in
/// an entity's raw record bytes, i.e. between the entity's own outer
/// parentheses, split on commas at paren-depth 1 (quote-aware, so a comma or
/// paren inside a string literal doesn't confuse the split).
fn nth_top_level_attribute(bytes: &[u8], attr_index: usize) -> Option<&[u8]> {
    let len = bytes.len();
    // Skip to the entity's own opening '(' (after "#N=TYPE").
    let mut i = 0;
    while i < len && bytes[i] != b'(' {
        i += 1;
    }
    if i >= len {
        return None;
    }
    i += 1;

    let mut depth: i32 = 1;
    let mut in_string: Option<u8> = None;
    let mut attr_start = i;
    let mut attr_idx = 0usize;

    while i < len {
        let b = bytes[i];
        if let Some(q) = in_string {
            if b == q {
                if i + 1 < len && bytes[i + 1] == q {
                    i += 2; // doubled-quote escape stays inside the string
                    continue;
                }
                in_string = None;
            }
            i += 1;
            continue;
        }
        match b {
            b'\'' | b'"' => {
                in_string = Some(b);
                i += 1;
            }
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return (attr_idx == attr_index).then(|| &bytes[attr_start..i]);
                }
                i += 1;
            }
            b',' if depth == 1 => {
                if attr_idx == attr_index {
                    return Some(&bytes[attr_start..i]);
                }
                attr_idx += 1;
                i += 1;
                attr_start = i;
            }
            _ => i += 1,
        }
    }
    None
}
