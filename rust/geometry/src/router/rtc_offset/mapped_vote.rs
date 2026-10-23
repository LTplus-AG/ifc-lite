// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The RTC vote of an `IfcMappedItem` (#7690 ROUTER-27).
//!
//! Civil 3D and 12d export terrain and corridor pieces as raw national-grid
//! face sets inside an `IfcRepresentationMap`, used by origin-placed products.
//! Without this vote such a product reads no vertex, votes its `(0,0,0)`
//! placement, the median stays zero and the source is narrowed to f32 at
//! survey magnitude: a 12 mm feature collapses onto the ~0.25 m f32 grid.

use super::GeometryRouter;
use crate::representation::{
    Flow, MappedLevel, NestedMaps, RepresentationWalk, Select, WalkCtx, WalkVisitor,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, MAX_MAPPED_ITEM_DEPTH};
use nalgebra::{Matrix4, Point3};

impl GeometryRouter {
    /// First vertex of a mapped item's source, in the frame of the
    /// representation holding `item` (raw file units, like the direct items'
    /// vertices `sample_first_geometry_vertex` returns).
    ///
    /// Follows `MappingSource → MappedRepresentation → Items` to the first item
    /// that yields a vertex, composing each level's `mapped_item_transform`
    /// (`MappingTarget · MappingOrigin`, the mesh path's own composition). A
    /// level whose items are all mapped descends into its FIRST mapped item
    /// only, so the walk is a single chain: iterative, bounded by the shared
    /// [`MAX_MAPPED_ITEM_DEPTH`] (the router's mapped-item cap) and a visited
    /// set that ends a cycle early. A chain that breaks, cycles, runs past the
    /// cap or has an unresolvable transform abstains (`None`), and the element
    /// falls back to its placement vote exactly as before.
    pub(super) fn mapped_item_first_vertex(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        let mut vote = FirstVertex { router: self, transform: Matrix4::identity(), vertex: None, abstain: false };
        let walk = RepresentationWalk {
            select: Select::Any,
            nested: NestedMaps::FirstChain { max_depth: MAX_MAPPED_ITEM_DEPTH },
        };
        walk.mapped_item(item, decoder, &mut vote);
        vote.vertex.filter(|_| !vote.abstain)
    }
}

/// Composes each level's `mapped_item_transform` along the chain and takes the
/// first item that yields a vertex. A level whose transform fails abstains.
struct FirstVertex<'a> {
    router: &'a GeometryRouter,
    transform: Matrix4<f64>,
    vertex: Option<(f64, f64, f64)>,
    abstain: bool,
}

impl WalkVisitor for FirstVertex<'_> {
    fn enter_map(&mut self, level: &MappedLevel, _at: &WalkCtx<'_>, decoder: &mut EntityDecoder) -> Flow {
        match level.local_transform(decoder) {
            Ok(Some(local)) => self.transform *= local,
            Ok(None) => {}
            Err(_) => {
                self.abstain = true;
                return Flow::Stop;
            }
        }
        Flow::Continue
    }

    fn item(&mut self, item: &DecodedEntity, _at: &WalkCtx<'_>, decoder: &mut EntityDecoder) -> Flow {
        let Some((x, y, z)) = self.router.item_first_vertex(item, decoder) else {
            return Flow::Continue;
        };
        let p = self.transform.transform_point(&Point3::new(x, y, z));
        self.vertex = Some((p.x, p.y, p.z));
        Flow::Stop
    }
}
