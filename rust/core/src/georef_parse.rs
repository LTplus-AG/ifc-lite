// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Compound-plane-angle parsing helpers for `georef.rs`'s legacy
//! `IfcSite.RefLatitude`/`RefLongitude` fallback.
//!
//! Split out of `georef.rs` to keep that module inside its module-size
//! ratchet budget (matching the `georef_tests.rs` split for test code):
//! these functions are cohesive (all exist to turn a STEP
//! `IfcCompoundPlaneAngleMeasure` list into signed decimal degrees) and are
//! only ever called from `georef.rs::extract_from_site`.

use crate::parser::StepListItems;
use crate::schema_gen::DecodedEntity;

/// Convert an `IfcCompoundPlaneAngleMeasure` attribute (list of 3-4
/// integers: degrees, minutes, seconds, optional millionth-seconds) to
/// decimal degrees. Same sign handling as the TS parser: any negative
/// component makes the whole angle negative.
///
/// Components are read BY POSITION and the whole angle is refused when any
/// of the first three is not numeric. Compacting the list first (dropping
/// non-numeric entries, then indexing the survivors) re-indexed
/// `($,51,30,0)` as 51 deg 30 min: the fourth component slid into the
/// seconds slot and the site was placed instead of refused.
pub(super) fn compound_plane_angle_to_degrees(entity: &DecodedEntity, index: usize) -> Option<f64> {
    let list = entity.get_list(index)?;
    if list.len() < 3 {
        return None;
    }
    let degrees = list[0].as_float()?;
    let minutes = list[1].as_float()?;
    let seconds = list[2].as_float()?;
    // The optional fourth component: absent is 0; present but non-numeric
    // is refused like the mandatory three.
    let millionths = match list.get(3) {
        Some(value) => value.as_float()?,
        None => 0.0,
    };
    let sign = if degrees < 0.0 || minutes < 0.0 || seconds < 0.0 || millionths < 0.0 {
        -1.0
    } else {
        1.0
    };
    let (degrees, minutes, seconds, millionths) =
        (degrees.abs(), minutes.abs(), seconds.abs(), millionths.abs());
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
/// entity is decoded the sign is already gone. The split is the shared
/// [`StepListItems`] rule, so a comment is trivia here too (#4687).
pub(super) fn compound_angle_has_literal_negative_zero(bytes: &[u8], attr_index: usize) -> bool {
    StepListItems::of_record(bytes)
        .and_then(|mut attributes| attributes.nth(attr_index))
        .and_then(StepListItems::of_list)
        .is_some_and(|mut components| components.any(|component| component == b"-0"))
}
