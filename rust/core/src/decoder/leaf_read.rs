// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one leaf-read rule for points and directions (F3b, D26, D3).
//!
//! `IfcCartesianPoint` and `IfcDirection` are read as the right IFC type
//! holding a list of 2 or 3 finite numbers. A 2D value gets `z = 0`. Anything
//! else (another type, a wrong length, a non-numeric or non-finite
//! component, a typed wrapper) is refused as [`Error::MalformedRecord`] and
//! counted in [`EntityDecoder::refused_records`], never defaulted to 0.
//!
//! The strict byte grammar answers the common case without building the
//! entity; any miss falls back to the full decode and applies the same rule to
//! the decoded values. A dangling id is the decode error, unchanged.
//! `get_cartesian_point_fast` is not a leaf reader: it stays the
//! type-agnostic probe for callers that must not count refusals.

use super::{parse_point_coordinates_end, EntityDecoder};
use crate::error::{Error, Result};
use crate::parser::skip_step_trivia;
use crate::schema_gen::{AttributeValue, DecodedEntity};
use crate::IfcType;

const POINT_KEYWORD: &[u8] = b"IFCCARTESIANPOINT";
const DIRECTION_KEYWORD: &[u8] = b"IFCDIRECTION";

/// `#id = KEYWORD ( ( x, y[, z] ) ) ;` with `keyword` matched case-insensitively.
#[inline]
fn fast_leaf(bytes: &[u8], keyword: &[u8]) -> Option<[f64; 3]> {
    let eq = bytes.iter().position(|&b| b == b'=')?;
    let start = skip_step_trivia(bytes, eq + 1)?;
    let end = start + keyword.len();
    if !bytes.get(start..end)?.eq_ignore_ascii_case(keyword) {
        return None;
    }
    let mut i = skip_step_trivia(bytes, end)?;
    for _ in 0..2 {
        (*bytes.get(i)? == b'(').then_some(())?;
        i = skip_step_trivia(bytes, i + 1)?;
    }
    let ((x, y, z), used) = parse_point_coordinates_end(&bytes[i..])?;
    let i = skip_step_trivia(bytes, i + used)?;
    (*bytes.get(i)? == b')' && x.is_finite() && y.is_finite() && z.is_finite()).then_some([x, y, z])
}

/// The rule applied to a decoded entity (the fast-path miss).
fn slow_leaf(entity: &DecodedEntity, ifc_type: IfcType) -> Option<[f64; 3]> {
    if entity.ifc_type != ifc_type || entity.get(1).is_some() {
        return None;
    }
    let AttributeValue::List(items) = entity.get(0)? else {
        return None;
    };
    if !(2..=3).contains(&items.len()) {
        return None;
    }
    let mut out = [0.0; 3];
    for (slot, item) in out.iter_mut().zip(items) {
        *slot = match item {
            AttributeValue::Float(v) => *v,
            AttributeValue::Integer(v) => *v as f64,
            _ => return None,
        };
        if !slot.is_finite() {
            return None;
        }
    }
    Some(out)
}

impl EntityDecoder<'_> {
    fn leaf3(&mut self, id: u32, keyword: &[u8], ifc_type: IfcType) -> Result<[f64; 3]> {
        if let Some(value) = self.get_raw_bytes(id).and_then(|bytes| fast_leaf(bytes, keyword)) {
            return Ok(value);
        }
        let entity = self.decode_by_id(id)?;
        slow_leaf(&entity, ifc_type).ok_or_else(|| self.refuse_malformed(id))
    }

    /// `IfcCartesianPoint` `id` under the leaf rule (module doc). A dangling
    /// id is the decode error; anything malformed is a counted
    /// [`Error::MalformedRecord`].
    pub fn point3(&mut self, id: u32) -> Result<[f64; 3]> {
        self.leaf3(id, POINT_KEYWORD, IfcType::IfcCartesianPoint)
    }

    /// `IfcDirection` `id` under the same rule: raw ratios, not normalised,
    /// zero allowed.
    pub fn direction3(&mut self, id: u32) -> Result<[f64; 3]> {
        self.leaf3(id, DIRECTION_KEYWORD, IfcType::IfcDirection)
    }

    /// Attribute `slot` of `entity` as a point: `$`, `*` or past the end is
    /// `Ok(None)`, `#n` is [`Self::point3`], anything else is a counted
    /// [`Error::MalformedRecord`] of `entity`.
    pub fn point3_at(&mut self, entity: &DecodedEntity, slot: usize) -> Result<Option<[f64; 3]>> {
        match self.leaf_ref(entity, slot)? {
            Some(id) => self.point3(id).map(Some),
            None => Ok(None),
        }
    }

    /// [`Self::point3_at`] for an `IfcDirection` slot.
    pub fn direction3_at(&mut self, entity: &DecodedEntity, slot: usize) -> Result<Option<[f64; 3]>> {
        match self.leaf_ref(entity, slot)? {
            Some(id) => self.direction3(id).map(Some),
            None => Ok(None),
        }
    }

    /// Optional reference slot: `$`, `*` or absent is `None`, `#n` is the
    /// decoded entity, any other value is a counted refusal of `entity`.
    pub fn resolve_optional(
        &mut self, entity: &DecodedEntity, slot: usize,
    ) -> Result<Option<DecodedEntity>> {
        match self.leaf_ref(entity, slot)? {
            Some(id) => self.decode_by_id(id).map(Some),
            None => Ok(None),
        }
    }

    fn leaf_ref(&self, entity: &DecodedEntity, slot: usize) -> Result<Option<u32>> {
        match entity.get(slot) {
            None | Some(AttributeValue::Null | AttributeValue::Derived) => Ok(None),
            Some(AttributeValue::EntityRef(id)) => Ok(Some(*id)),
            Some(_) => Err(self.refuse_malformed(entity.id)),
        }
    }

    /// Count and return the refusal of malformed geometry input `id` (D3),
    /// as [`Self::refuse_record`] does for reals; both feed
    /// [`Self::refused_records`].
    pub fn refuse_malformed(&self, id: u32) -> Error {
        let _counted = self.refuse_record(id);
        Error::MalformedRecord(id)
    }
}

#[cfg(test)]
#[path = "leaf_read_tests.rs"]
mod tests;
