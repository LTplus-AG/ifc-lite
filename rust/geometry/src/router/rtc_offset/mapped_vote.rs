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
    Flow, MappedLevel, NestedMaps, RepresentationWalk, Select, WalkCtx, WalkRefusal, WalkVisitor,
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
        match self.router.mapped_item_transform(&level.item, &level.map, decoder) {
            Ok(Some(local)) => self.transform *= local,
            Ok(None) => {}
            Err(_) => {
                self.abstain = true;
                return Flow::Stop;
            }
        }
        Flow::Continue
    }

    fn refused(&mut self, _item: &DecodedEntity, _why: WalkRefusal, _ctx: &WalkCtx<'_>) {
        // This FirstChain probe produces no mesh. A broken/cyclic/deep chain
        // abstains so the element retains its placement vote (#7781/#8020).
        self.abstain = true;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_7781_malformed_nested_items_abstain_without_trying_a_mapped_sibling() {
        for items in ["", ",7", ",(#1)"] {
            let model = format!(
                "#10=IFCMAPPEDITEM(#20,$);\
                #20=IFCREPRESENTATIONMAP($,#30);\
                #30=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#40,#50));\
                #40=IFCMAPPEDITEM(#60,$);#60=IFCREPRESENTATIONMAP($,#70);\
                #70=IFCSHAPEREPRESENTATION($,'Body','Brep'{items});\
                #50=IFCMAPPEDITEM(#80,$);#80=IFCREPRESENTATIONMAP($,#90);\
                #90=IFCSHAPEREPRESENTATION($,'Body','Brep',(#2));\
                #1=IFCCARTESIANPOINT((5000000.,2.,3.));\
                #2=IFCCARTESIANPOINT((6000000.,2.,3.));"
            );
            let mut decoder = EntityDecoder::new(&model);
            let root = decoder.decode_by_id(10).unwrap();
            let vote = GeometryRouter::new().mapped_item_first_vertex(&root, &mut decoder);
            if items == ",(#1)" {
                assert_eq!(vote, Some((5000000., 2., 3.)), "valid first-chain control");
            } else {
                assert_eq!(vote, None, "malformed nested Items must abstain");
            }
            assert!(
                decoder.get_cached(50).is_some(),
                "root list resolves both siblings"
            );
            assert!(
                decoder.get_cached(80).is_none(),
                "FirstChain never enters the later sibling"
            );
            assert!(decoder.get_cached(2).is_none());
        }
    }
}
