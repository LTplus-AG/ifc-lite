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
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType, MAX_MAPPED_ITEM_DEPTH};
use nalgebra::{Matrix4, Point3};
use rustc_hash::FxHashSet;

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
        let mut transform = Matrix4::<f64>::identity();
        let mut cursor = item.clone();
        let mut visited = FxHashSet::default();
        for _ in 0..MAX_MAPPED_ITEM_DEPTH {
            if !visited.insert(cursor.id) {
                return None;
            }
            // attr 0 = MappingSource (IfcRepresentationMap)
            let source = decoder.resolve_ref(cursor.get(0)?).ok()??;
            if let Some(level) = self.mapped_item_transform(&cursor, &source, decoder).ok()? {
                transform *= level;
            }
            // IfcRepresentationMap attr 1 = MappedRepresentation; its attr 3 = Items
            let representation = decoder.resolve_ref(source.get(1)?).ok()??;
            let items = decoder.resolve_ref_list(representation.get(3)?).ok()?;
            let mut nested = None;
            for inner in items {
                if inner.ifc_type == IfcType::IfcMappedItem {
                    nested = nested.or(Some(inner));
                } else if let Some((x, y, z)) = self.item_first_vertex(&inner, decoder) {
                    let p = transform.transform_point(&Point3::new(x, y, z));
                    return Some((p.x, p.y, p.z));
                }
            }
            cursor = nested?;
        }
        None
    }
}
