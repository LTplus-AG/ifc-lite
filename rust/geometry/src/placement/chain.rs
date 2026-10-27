// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The world transform of an `IfcObjectPlacement`: [`resolve_chain`] and
//! friends. `PlacementRelTo` has fan-out 1, so the walk is a loop with a
//! visited set and **no depth cap** (D27): a cycle is refused and counted, a
//! chain of any length resolves in full, and the memo entry of a placement is
//! a pure function of `(content, id)`.
//!
//! The memo is the decoder's `placement_transform_cache`. This module owes it
//! the discipline its doc names: complete results only, **unscaled** (file
//! units), column-major, keyed by placement id (plus the owning-grid axis id,
//! which holds the grid's `ObjectPlacement` world). Errors are never memoised.

use super::chain_walk::{climb, Climb, Frame};
use super::{grid, linear, missing, unsupported, Axis2Placement, PlacementResult};
use crate::math::mat4;
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;
use smallvec::SmallVec;

/// What a placement in a chain is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    /// `IfcLocalPlacement`
    Local,
    /// `IfcLinearPlacement`
    Linear,
    /// `IfcGridPlacement`
    Grid,
}

/// One placement of a chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Link {
    pub id: u32,
    pub kind: LinkKind,
}

/// The unscaled world transform of `placement`, composed
/// `((T_root·L_1)·L_2)…·L_leaf` up `PlacementRelTo`.
///
/// Nothing is defaulted (D30): a record that is not a placement, a `$`
/// `RelativePlacement`, a `RelativePlacement` that is not an `IfcAxis2Placement`
/// and a linear or grid frame that cannot be sampled are refused and counted.
/// A 2D `RelativePlacement` is honoured, as the IFC select allows.
pub fn resolve_chain(placement: &DecodedEntity, decoder: &mut EntityDecoder) -> PlacementResult<Matrix4<f64>> {
    // The hot path: a memo hit is one lookup, before anything is allocated.
    if let Some(m) = decoder.get_placement_transform_cached(placement.id) {
        return Ok(Matrix4::from_column_slice(&m));
    }
    let mut climbed = Climb::new();
    climb(&mut climbed, placement, decoder, true, true, None)?;
    if let Some((at, found)) = climbed.stopped_at {
        return Err(unsupported(decoder, at, found));
    }
    let mut acc = climbed.base;
    for frame in climbed.frames.iter().rev() {
        if let Some(axis_id) = frame.alias {
            decoder.cache_placement_transform(axis_id, mat4::col_major_array(&acc));
        }
        acc *= frame_matrix(frame, decoder)?;
        decoder.cache_placement_transform(frame.entity.id, mat4::col_major_array(&acc));
    }
    Ok(acc)
}


/// The unscaled world transform of `product`'s `ObjectPlacement` (attribute 5).
/// `Ok(None)` iff it is `$`, `*` or absent: "genuinely missing"
/// stays the identity at the caller (#2256).
pub fn resolve_object_placement(
    product: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> PlacementResult<Option<Matrix4<f64>>> {
    match decoder.resolve_optional(product, slot::IfcProduct::OBJECT_PLACEMENT.index())? {
        Some(placement) => resolve_chain(&placement, decoder).map(Some),
        None => Ok(None),
    }
}

/// The placements from `placement` up to the root, leaf first, cycle-checked.
/// No transforms are composed and the memo is not consulted.
pub fn chain(placement: &DecodedEntity, decoder: &mut EntityDecoder) -> PlacementResult<SmallVec<[Link; 8]>> {
    let mut climbed = Climb::new();
    climb(&mut climbed, placement, decoder, false, false, None)?;
    if let Some((at, found)) = climbed.stopped_at {
        return Err(unsupported(decoder, at, found));
    }
    Ok(climbed.frames.iter().map(|f| Link { id: f.entity.id, kind: f.kind }).collect())
}

/// The local-to-parent frame of one link. A frame that cannot be read or
/// sampled is refused, never the identity: the element would sit at its
/// parent's origin instead of being counted as lost (D3, D30).
pub(super) fn frame_matrix(frame: &Frame, decoder: &mut EntityDecoder) -> PlacementResult<Matrix4<f64>> {
    let entity = &frame.entity;
    let at = entity.id;
    Ok(match frame.kind {
        LinkKind::Local => {
            let rel = decoder
                .resolve_optional(entity, slot::IfcLocalPlacement::RELATIVE_PLACEMENT.index())?
                .ok_or_else(|| missing(decoder, at, "RelativePlacement"))?;
            Axis2Placement::read(&rel, decoder)?.matrix()
        }
        LinkKind::Linear => linear::local_frame(entity, decoder)?,
        LinkKind::Grid => {
            let ctx = frame.grid.as_ref()
                .ok_or_else(|| missing(decoder, at, "a resolvable grid intersection"))?;
            grid::local_frame(entity, ctx, decoder)?
        }
    })
}
