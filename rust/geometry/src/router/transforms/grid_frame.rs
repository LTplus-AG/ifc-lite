// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-schema `IfcGridPlacement` layout and the IFC2X3/IFC4 owning-grid frame
//! (#6232 F2).

use super::super::GeometryRouter;
use super::mat4_to_col_array;
use super::walk::PlacementWalk;
use crate::Result;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

/// Where `IfcGridPlacement`'s attributes sit in this source's schema.
///
/// IFC4X1 added the inherited `IfcObjectPlacement.PlacementRelTo`, so IFC4X1+
/// reads `(PlacementRelTo, PlacementLocation, PlacementRefDirection)` and
/// IFC2X3/IFC4 read `(PlacementLocation, PlacementRefDirection)`. The
/// positions come from the declared schema's generated registry
/// ([`EntityDecoder::attribute_index`]), never from a second hard-coded table.
/// `PlacementRefDirection` is an `IfcVirtualGridIntersection` on IFC2X3 and an
/// `IfcGridPlacementDirectionSelect` (IfcDirection | IfcVirtualGridIntersection)
/// from IFC4 on; [`GeometryRouter::grid_ref_direction_vector`] dispatches on
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
        let mut index = |name| decoder.attribute_index("IfcGridPlacement", name);
        Self {
            rel_to: index("PlacementRelTo"),
            location: index("PlacementLocation"),
            ref_direction: index("PlacementRefDirection"),
        }
    }
}

impl GeometryRouter {
    /// World transform of the `IfcGrid` that owns `intersection`'s first axis
    /// (IFC2X3/IFC4, where `IfcGridPlacement` has no `PlacementRelTo`).
    /// Identity when no grid lists the axis or the grid has no placement.
    ///
    /// Memoised in the per-worker placement memo under the AXIS id: the grid
    /// frame is a pure function of the source and that id (entity ids are
    /// unique, so it cannot collide with a placement's own entry), and keying
    /// it there spares every later grid-placed element the owner scan
    /// ([`EntityDecoder::grid_of_axis`]) that a fresh per-element decoder would
    /// otherwise repeat. Truncated walks stay out of the memo, as everywhere.
    pub(super) fn owning_grid_frame(
        &self,
        intersection: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: usize,
    ) -> Result<PlacementWalk> {
        let identity = PlacementWalk::complete(Matrix4::identity());
        let Some(axis_id) = intersection
            .get_refs(0)
            .and_then(|axes| axes.first().copied())
        else {
            return Ok(identity);
        };
        if let Some(m) = decoder.get_placement_transform_cached(axis_id) {
            return Ok(PlacementWalk::complete(Matrix4::from_column_slice(&m)));
        }
        let grid_placement = match decoder.grid_of_axis(axis_id) {
            Some(grid_id) => {
                let grid = decoder.decode_by_id(grid_id)?;
                let slot = decoder.attribute_index("IfcGrid", "ObjectPlacement");
                match slot
                    .and_then(|i| grid.get(i))
                    .filter(|attr| !attr.is_null())
                {
                    Some(attr) => decoder.resolve_ref(attr)?,
                    None => None,
                }
            }
            None => None,
        };
        let walk = match grid_placement {
            Some(p) => self.get_placement_transform_with_depth(&p, decoder, depth + 1)?,
            None => identity,
        };
        if !walk.truncated {
            decoder.cache_placement_transform(axis_id, mat4_to_col_array(&walk.transform));
        }
        Ok(walk)
    }
}
