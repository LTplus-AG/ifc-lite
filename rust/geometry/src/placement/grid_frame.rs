// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-schema `IfcGridPlacement` layout and the IFC2X3/IFC4 owning-grid frame
//! (#6232 F2).

use super::PlacementResult;
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

/// Where `IfcGridPlacement`'s attributes sit in this source's schema.
///
/// IFC4X1 added the inherited `IfcObjectPlacement.PlacementRelTo`, so IFC4X1+
/// reads `(PlacementRelTo, PlacementLocation, PlacementRefDirection)` and
/// IFC2X3/IFC4 read `(PlacementLocation, PlacementRefDirection)`. The
/// positions come from the declared schema's generated registry
/// ([`EntityDecoder::slot`]), never from a second hard-coded table.
/// `PlacementRefDirection` is an `IfcVirtualGridIntersection` on IFC2X3 and an
/// `IfcGridPlacementDirectionSelect` (IfcDirection | IfcVirtualGridIntersection)
/// from IFC4 on; `grid::ref_direction_vector` dispatches on
/// the referenced entity's type, so one reader covers both.
pub(super) struct GridPlacementLayout {
    /// `None` on IFC2X3/IFC4: the placement is implicitly in the frame of the
    /// `IfcGrid` its axes belong to.
    pub(super) rel_to: Option<usize>,
    pub(super) location: Option<usize>,
    pub(super) ref_direction: Option<usize>,
}

impl GridPlacementLayout {
    pub(super) fn of(decoder: &mut EntityDecoder) -> Self {
        Self {
            rel_to: decoder.slot(slot::IfcGridPlacement::PLACEMENT_REL_TO).map(|s| s.index()),
            location: decoder.slot(slot::IfcGridPlacement::PLACEMENT_LOCATION).map(|s| s.index()),
            ref_direction: decoder.slot(slot::IfcGridPlacement::PLACEMENT_REF_DIRECTION).map(|s| s.index()),
        }
    }
}

/// The frame a grid placement without `PlacementRelTo` sits in.
pub(super) enum OwningFrame {
    /// No grid lists the axis: the identity, not memoised.
    Identity,
    /// Already memoised under the axis id.
    Cached(Matrix4<f64>),
    /// The owning grid's `ObjectPlacement` (`None`: the grid has none, the
    /// identity); the walk memoises its world under `axis_id`.
    Walk { parent: Option<DecodedEntity>, axis_id: u32 },
}

/// The `IfcGrid` that owns `intersection`'s first axis (IFC2X3/IFC4, where
/// `IfcGridPlacement` has no `PlacementRelTo`) and its `ObjectPlacement`.
///
/// Memoised in the per-worker placement memo under the AXIS id: the grid
/// frame is a pure function of the source and that id (entity ids are
/// unique, so it cannot collide with a placement's own entry), and keying
/// it there spares every later grid-placed element the owner scan
/// ([`EntityDecoder::grid_of_axis`]) that a fresh per-element decoder would
/// otherwise repeat.
pub(super) fn owning_grid_frame(
    intersection: &DecodedEntity,
    decoder: &mut EntityDecoder,
    use_transform_cache: bool,
) -> PlacementResult<OwningFrame> {
    let Some(axis_id) = intersection.ref_list_at(slot::IfcVirtualGridIntersection::INTERSECTING_AXES).and_then(|axes| axes.first().copied()) else {
        return Ok(OwningFrame::Identity);
    };
    // A composed transform is not evidence that a validation policy holds.
    // Non-meshing walks must include the owner regardless of renderer warmth.
    if use_transform_cache {
        if let Some(m) = decoder.get_placement_transform_cached(axis_id) {
            return Ok(OwningFrame::Cached(Matrix4::from_column_slice(&m)));
        }
    }
    let parent = match decoder.grid_of_axis(axis_id) {
        Some(grid_id) => {
            let grid = decoder.decode_by_id(grid_id)?;
            decoder.resolve_optional(&grid, slot::IfcGrid::OBJECT_PLACEMENT.index())?
        }
        None => None,
    };
    Ok(OwningFrame::Walk { parent, axis_id })
}
