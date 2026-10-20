// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Index handling shared by both tessellated face sets (#7689).
//!
//! The per-value rule (1-based `IfcPositiveInteger`; `0`, negatives, values
//! past `u32::MAX` and REALs are not indices) lives in `ifc_lite_core`
//! (`ifc_index_to_zero_based`, `AttributeValue::as_ifc_index`), which both
//! CoordIndex grammars apply. This module adds the one `PnIndex` remap: when
//! the attribute is present, a CoordIndex value indexes `PnIndex`, whose
//! value indexes `Coordinates`. A corner that fails at either step is
//! [`INVALID_INDEX`] and its face is dropped downstream; it never falls back
//! to indexing `Coordinates` directly.

use crate::{Error, Result};
use ifc_lite_core::{
    extract_face_indices_from_entity, slot, AttributeValue, DecodedEntity, EntityDecoder,
    INVALID_INDEX,
};

/// `PnIndex` (attribute `attr`) as 0-based `Coordinates` positions, or
/// `None` when it is `$`. An entry that fails the index rule stays in place
/// as [`INVALID_INDEX`]: dropping it would shift every later entry onto the
/// wrong point.
///
/// A list of LISTS in that slot is not a `PnIndex` and reads as absent: the
/// original IFC4 (2013) release declared attribute 4 of
/// `IfcTriangulatedFaceSet` as `NormalIndex : LIST OF LIST [3:3]`, which a
/// later IFC4 addendum replaced with `PnIndex`. Read as a `PnIndex`, every
/// entry would be invalid and the whole face set would vanish.
pub(super) fn read_pn_index(entity: &DecodedEntity, attr: usize) -> Option<Vec<u32>> {
    let list = entity.get(attr)?.as_list()?;
    if list.iter().any(|v| v.as_list().is_some()) {
        return None;
    }
    Some(
        list.iter()
            .map(|v| v.as_ifc_index().unwrap_or(INVALID_INDEX))
            .collect(),
    )
}

/// A 0-based CoordIndex corner as a 0-based `Coordinates` position: itself
/// without `PnIndex`, its `PnIndex` entry with one. [`INVALID_INDEX`] when
/// the corner is past the end of `PnIndex` or already invalid.
#[inline]
pub(super) fn through_pn_index(corner: u32, pn_index: Option<&[u32]>) -> u32 {
    match pn_index {
        None => corner,
        Some(pn_index) => pn_index
            .get(corner as usize)
            .copied()
            .unwrap_or(INVALID_INDEX),
    }
}

/// One corner of an `IfcIndexedPolygonalFace` loop as the 1-based position
/// `triangulate_polygon` takes, with `0` for a corner that fails the rule
/// (which drops the whole face there).
#[inline]
pub(super) fn polygon_corner(value: &AttributeValue, pn_index: Option<&[u32]>) -> u32 {
    let corner = value
        .as_ifc_index()
        .map_or(INVALID_INDEX, |z| through_pn_index(z, pn_index));
    corner.checked_add(1).unwrap_or(0)
}

/// An `IfcTriangulatedFaceSet`'s `CoordIndex` (attribute 3) as flat 0-based
/// corners, three per face, before any `PnIndex` remap. The raw-byte grammar
/// answers when it can and otherwise defers to the decoded one; both apply
/// the same rule, so which runs never changes the mesh.
pub(super) fn read_triangle_coord_index(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Vec<u32>> {
    if let Some(indices) = decoder
        .get_raw_bytes(entity.id)
        .and_then(extract_face_indices_from_entity)
    {
        return Ok(indices);
    }
    let face_list = entity
        .attr(slot::IfcTriangulatedFaceSet::COORD_INDEX)
        .ok_or_else(|| Error::geometry("TriangulatedFaceSet missing CoordIndex".to_string()))?
        .as_list()
        .ok_or_else(|| Error::geometry("Expected face index list".to_string()))?;
    Ok(AttributeValue::parse_index_list(face_list))
}
