// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The `IfcObjectPlacement` chain walk: compose `PlacementRelTo` upward into a
//! world transform, bounded by a depth cap and memoised per decoder.

use super::super::GeometryRouter;
use super::mat4_to_col_array;
use crate::Result;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;

/// A placement walk's composed transform plus whether the depth guard cut the
/// walk short. `truncated` is sticky upward: a node whose parent walk truncated
/// composed `identity * local`, which is not that node's world transform, so
/// every ancestor built on it is truncated too. Only an untruncated result is a
/// pure function of the placement id, and only those may reach the memo. #3012
///
/// This does NOT make an over-cap chain order-independent — only the direction
/// that matters. A memo hit is a return, not a frame, so a walk that finds a
/// warm ancestor near the cap composes PAST the cap for free: the same leaf of a
/// `MAX_PLACEMENT_DEPTH + 8` chain legitimately reports 101 from a cold decoder
/// and 109 from one warmed at the node the guard would have refused. Both are
/// legal under a cap that stops rather than promising an answer, and the longer
/// one is the whole chain, i.e. the more correct of the two. What is excluded
/// here is the narrower and worse case: a SHORT answer served from the memo as
/// though it were whole.
#[derive(Clone, Copy)]
pub(super) struct PlacementWalk {
    pub(super) transform: Matrix4<f64>,
    pub(super) truncated: bool,
}

impl PlacementWalk {
    /// A complete (untruncated) result.
    pub(super) fn complete(transform: Matrix4<f64>) -> Self {
        Self { transform, truncated: false }
    }
}

impl GeometryRouter {
    /// Recursively resolve placement hierarchy
    ///
    /// Bounded by [`Self::MAX_PLACEMENT_DEPTH`] so a malformed file with a
    /// circular or absurdly deep placement hierarchy cannot overflow the stack.
    pub(super) fn get_placement_transform(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        Ok(self
            .get_placement_transform_with_depth(placement, decoder, 0)?
            .transform)
    }

    /// Internal helper with depth tracking to prevent stack overflow.
    ///
    /// The bound is [`ifc_lite_core::limits::MAX_PLACEMENT_DEPTH`], shared with
    /// `profile_extractor`'s walk over the same attribute. It was a private 32
    /// against that walk's 100, and since both exceed-branches return the
    /// identity the two paths drew a deep chain in two places, silently. #2873
    pub(super) const MAX_PLACEMENT_DEPTH: usize = ifc_lite_core::MAX_PLACEMENT_DEPTH;

    pub(super) fn get_placement_transform_with_depth(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: usize,
    ) -> Result<PlacementWalk> {
        // Per-worker placement-transform memo, consulted BEFORE the depth guard
        // below. For a well-formed acyclic IFC placement DAG the composed world
        // transform is a pure function of `placement.id`, so returning a cached
        // result is byte-identical — and it collapses the repeated work:
        // storey/building placements shared by thousands of elements compose
        // once per worker, not once per element.
        //
        // Only untruncated computed transforms (local/linear/grid) are cached:
        // a walk that hit the depth guard composed part of the chain, and what
        // it composed depends on the depth it was ENTERED at, not on the
        // placement id alone. Caching one made the first caller's depth budget
        // every later caller's answer for that node (#3012), so a cache hit is
        // depth-independent only because truncated results never enter.
        //
        // Because every entry is a complete transform, serving one is always
        // better than refusing it, and the guard must not get there first: a
        // memo hit RETURNS, it does not recurse, so it costs no stack — measured
        // max recursion depth over a `MAX_PLACEMENT_DEPTH + 8` chain is 101 both
        // cold and when the hit lands on the node the guard would have refused.
        // Checking the guard first threw away a complete cached transform and
        // handed back a shorter one in its place.
        if let Some(m) = decoder.get_placement_transform_cached(placement.id) {
            return Ok(PlacementWalk::complete(Matrix4::from_column_slice(&m)));
        }

        // Depth limit to prevent stack overflow on circular references or deep
        // hierarchies, reached only on a memo MISS — the frames it bounds are
        // the ones that would actually recurse. The identity here is NOT this
        // placement's transform, so the walk is flagged truncated all the way
        // back up.
        if depth > Self::MAX_PLACEMENT_DEPTH {
            return Ok(PlacementWalk { transform: Matrix4::identity(), truncated: true });
        }

        // IfcLinearPlacement is the IFC4x3 placement used by infrastructure
        // models to put products at a station along an alignment / gradient
        // curve. Without dedicated handling, every linearly-placed element
        // (signals, referents, signs on a railway alignment) falls back to
        // identity here and piles up at world origin — the exact symptom
        // reported in issue #859 on the `linear-placement-of-signal` fixture.
        //
        // Attribute layout (IFC4x3):
        //   0 PlacementRelTo (IfcObjectPlacement, optional) — same as IfcLocalPlacement
        //   1 RelativePlacement (IfcAxis2PlacementLinear) — required, samples the curve
        //   2 CartesianPosition (IfcAxis2Placement3D, optional) — pre-baked world fallback
        if placement.ifc_type == IfcType::IfcLinearPlacement {
            let walk = self.resolve_linear_placement_with_depth(placement, decoder, depth)?;
            if !walk.truncated {
                decoder
                    .cache_placement_transform(placement.id, mat4_to_col_array(&walk.transform));
            }
            return Ok(walk);
        }

        // IfcGridPlacement positions a product on a grid-axis intersection
        // instead of a local coordinate system. Without dedicated handling
        // every grid-placed element (columns laid out on a structural grid)
        // falls back to identity here and stacks at the world origin — the
        // exact symptom reported in issue #883 on the `ifcgrid` fixture.
        if placement.ifc_type == IfcType::IfcGridPlacement {
            let walk = self.resolve_grid_placement_with_depth(placement, decoder, depth)?;
            if !walk.truncated {
                decoder
                    .cache_placement_transform(placement.id, mat4_to_col_array(&walk.transform));
            }
            return Ok(walk);
        }

        if placement.ifc_type != IfcType::IfcLocalPlacement {
            return Ok(PlacementWalk::complete(Matrix4::identity()));
        }

        // Get parent transform first (attribute 0: PlacementRelTo)
        let parent = match placement.get(0) {
            Some(parent_attr) if !parent_attr.is_null() => {
                match decoder.resolve_ref(parent_attr)? {
                    Some(p) => self.get_placement_transform_with_depth(&p, decoder, depth + 1)?,
                    None => PlacementWalk::complete(Matrix4::identity()),
                }
            }
            _ => PlacementWalk::complete(Matrix4::identity()),
        };

        // Get local transform (attribute 1: RelativePlacement)
        let local_transform = if let Some(rel_attr) = placement.get(1) {
            if !rel_attr.is_null() {
                if let Some(rel) = decoder.resolve_ref(rel_attr)? {
                    if rel.ifc_type == IfcType::IfcAxis2Placement3D {
                        self.parse_axis2_placement_3d(&rel, decoder)?
                    } else {
                        Matrix4::identity()
                    }
                } else {
                    Matrix4::identity()
                }
            } else {
                Matrix4::identity()
            }
        } else {
            Matrix4::identity()
        };

        // Compose: parent * local
        let result = parent.transform * local_transform;
        if !parent.truncated {
            decoder.cache_placement_transform(placement.id, mat4_to_col_array(&result));
        }
        Ok(PlacementWalk { transform: result, truncated: parent.truncated })
    }
}
