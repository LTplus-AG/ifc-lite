// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::Mesh;

impl Mesh {
    /// Build a mesh with FRESH geometry buffers (`positions` / `normals` /
    /// `indices`) that carries THIS mesh's placement/frame metadata forward:
    /// `origin` (RTC / local-frame translation), `rtc_applied`, `local_bounds`
    /// and `local_to_world` (the #1474 placement capture).
    ///
    /// This is the correct constructor for an in-place rebuild pass that
    /// REPLACES the vertex buffers of an already-placed mesh (sliver refine,
    /// subdivide, weld). Constructing a bare `Mesh` and copying back only a
    /// field or two silently resets `origin` and the #1474 capture to their
    /// defaults, which mis-places the rebuilt host at the world origin on
    /// local-framed (large / georeferenced) models — see facet_weld's
    /// sliver-refine and this module's `subdivide_once` / `weld_impl`.
    ///
    /// `instance_meta` is intentionally NOT carried. Every such rebuild CHANGES
    /// the vertices, so the mesh no longer reproduces its representation's
    /// canonical geometry; carrying the (vertex-invariant) `rep_identity`
    /// forward would let the GPU-instancing collator dedup this changed mesh
    /// against an *unrefined* sibling that shares the same `rep_identity` and
    /// draw the wrong geometry. Dropping it mirrors the void-cut path, which
    /// nulls `instance_meta` for exactly this reason.
    ///
    /// # Precondition
    ///
    /// The new buffers MUST NOT extend the mesh's spatial extent beyond the
    /// original: the carried `local_bounds` stays valid only because it remains
    /// a *superset* of the rebuilt vertices' extent. This holds for every
    /// current caller — sliver-refine and subdivide insert edge/interior
    /// midpoints (convex combinations that lie inside the existing hull), and
    /// weld only merges/moves coincident vertices to a snapped position (a
    /// subset extent). A future caller that GROWS the extent (adds vertices
    /// outside the original hull) must NOT use this constructor for
    /// `local_bounds`: it has to recompute `local_bounds` from the new positions
    /// or pass through a variant that sets it to `None`.
    pub fn rebuilt_like(&self, positions: Vec<f32>, normals: Vec<f32>, indices: Vec<u32>) -> Mesh {
        Mesh {
            positions,
            normals,
            indices,
            rtc_applied: self.rtc_applied,
            origin: self.origin,
            instance_meta: None,
            local_bounds: self.local_bounds,
            local_to_world: self.local_to_world,
            welded_in_object_frame: false,
            plane_tags: None,
        }
    }

    /// A mesh whose vertices were MOVED by a frame change (rotation,
    /// translation, or a rebuild from f64 triangles): `rtc_applied` rides along
    /// from `self`, `origin` is the caller's, and everything that described the
    /// pre-move vertices is dropped (`instance_meta`, `local_bounds`,
    /// `local_to_world`, `welded_in_object_frame`, `plane_tags`).
    ///
    /// The counterpart of [`Mesh::rebuilt_like`], which keeps `local_bounds` and
    /// `local_to_world` because its precondition is that the extent does not
    /// move. A void-cut intermediate in a rotated frame breaks that
    /// precondition, so the voids path builds its frame-derived meshes here
    /// instead of spelling the struct out at each site.
    pub(crate) fn reframed_like(
        &self,
        positions: Vec<f32>,
        normals: Vec<f32>,
        indices: Vec<u32>,
        origin: [f64; 3],
    ) -> Mesh {
        Mesh {
            positions,
            normals,
            indices,
            rtc_applied: self.rtc_applied,
            origin,
            instance_meta: None,
            local_bounds: None,
            local_to_world: None,
            welded_in_object_frame: false,
            plane_tags: None,
        }
    }
}
