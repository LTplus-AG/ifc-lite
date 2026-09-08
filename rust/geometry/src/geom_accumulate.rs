// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Folding one mesh segment's triangles into the hasher's private
//! accumulators (vertex set, per-plane area, world bounds, volume, closure).
//!
//! Split out of the parent `geom_hash` module (whose child it is, so it
//! reaches [`GeometryHasher`]'s private fields directly) because HOW a
//! segment's triangles get folded in — the world reconstruction, the
//! quantization, the per-triangle degenerate/volume/bounds bookkeeping — is a
//! separate subject from what the surface channels mean ([`super::surface`])
//! or what the struct/gate around them expose.

use super::surface::{self, plane_of, vertex_hash};
use super::{quantize, GeometryHasher};
use crate::kernel::signed_volume::tetra_volume6;
use crate::mesh_orient::OrientVerdict;

impl GeometryHasher {
    /// Reconstruct the full `f64` WORLD coordinate of one vertex. `origin` is
    /// the per-mesh local-frame origin (`world = origin + position`); pass
    /// `[0.0; 3]` for absolute-coordinate positions.
    #[inline]
    fn world(&self, positions: &[f32], vi: usize, origin: &[f64; 3]) -> [f64; 3] {
        let base = vi * 3;
        [
            positions[base] as f64 + origin[0] + self.rtc[0],
            positions[base + 1] as f64 + origin[1] + self.rtc[1],
            positions[base + 2] as f64 + origin[2] + self.rtc[2],
        ]
    }

    /// Snap a reconstructed world corner to the quantization grid.
    #[inline]
    fn quantize_corner(&self, world: &[f64; 3]) -> [i64; 3] {
        [
            quantize(world[0], self.inv_tol),
            quantize(world[1], self.inv_tol),
            quantize(world[2], self.inv_tol),
        ]
    }

    /// Add one mesh segment (a flat `[x,y,z, ...]` position buffer and a
    /// triangle index buffer). Indices that run past the position buffer or
    /// trailing non-triangle remainder are skipped defensively.
    pub fn add_mesh(&mut self, positions: &[f32], indices: &[u32]) {
        self.add_mesh_with_origin(positions, indices, [0.0; 3]);
    }

    /// Like [`Self::add_mesh`] but for positions stored in a per-element LOCAL
    /// frame: `origin` (the per-mesh AABB-centre origin) is folded back so the
    /// hash is over absolute world coordinates. This keeps the fingerprint
    /// identical whether the producer emitted absolute positions (native) or
    /// local + origin (the wasm local-frame path), and still detects element
    /// MOVES.
    ///
    /// The segment carries no topology verdict, so it counts as NOT a closed
    /// solid and permanently disarms [`Self::volume`]. Producers that ran
    /// [`crate::orient_mesh_outward_verdict`] on this exact buffer should call
    /// [`Self::add_oriented_mesh`] instead.
    pub fn add_mesh_with_origin(&mut self, positions: &[f32], indices: &[u32], origin: [f64; 3]) {
        self.add_oriented_mesh(positions, indices, origin, OrientVerdict::INDETERMINATE);
    }

    /// [`Self::add_mesh_with_origin`] for a segment the producer just ran the
    /// outward-orienter over, passing that pass's [`OrientVerdict`] along.
    ///
    /// `verdict` MUST describe this exact position/index buffer — the volume
    /// below is only as honest as the closedness claim behind it. Anything
    /// short of a single closed orientable component disarms the element's
    /// volume permanently; see [`Self::volume`].
    pub fn add_oriented_mesh(
        &mut self,
        positions: &[f32],
        indices: &[u32],
        origin: [f64; 3],
        verdict: OrientVerdict,
    ) {
        // Σ 6·V for THIS segment, referenced to its own first in-range corner
        // (`vol_ref`). Any reference gives the same total on a closed surface,
        // but referencing a point ON the surface keeps every operand bounded by
        // the segment's own diameter — a georeferenced model at 1e5 m would
        // otherwise multiply three ~1e5 coordinates and cancel a ~1 m³ answer
        // out of ~1e15, losing every significant digit.
        let mut seg_volume6 = 0.0f64;
        let mut vol_ref: Option<[f64; 3]> = None;
        let vertex_limit = positions.len() / 3;
        let triangle_end = indices.len() - (indices.len() % 3);
        let mut i = 0;
        while i < triangle_end {
            let i0 = indices[i] as usize;
            let i1 = indices[i + 1] as usize;
            let i2 = indices[i + 2] as usize;
            i += 3;
            if i0 >= vertex_limit || i1 >= vertex_limit || i2 >= vertex_limit {
                continue;
            }

            let world = [
                self.world(positions, i0, &origin),
                self.world(positions, i1, &origin),
                self.world(positions, i2, &origin),
            ];

            // Bounds take EVERY in-range corner, including those of triangles
            // the hash rejects as post-quantization degenerate below. A sliver
            // or zero-area face carries no shape signal for the fingerprint,
            // but its corners are real geometry and do contribute extent —
            // dropping them would under-report the element's box.
            for corner in &world {
                self.extend_bounds(corner);
            }

            // Volume accumulates HERE, from `world`, whose corners are still in
            // the buffer's authored order. The quantized copy `tri` below is
            // SORTED (that is what makes the fingerprint winding-invariant), so
            // anything downstream of that sort has no winding left to integrate.
            //
            // Every in-range triangle counts, including the ones the hash drops
            // as post-quantization degenerate: a sub-millimetre sliver carries
            // no shape signal for a fingerprint, but it is part of the closed
            // surface, and its (near-zero) flux belongs in the sum.
            let o = *vol_ref.get_or_insert(world[0]);
            seg_volume6 += tetra_volume6(&world[0], &world[1], &world[2], &o);

            // Sort the three quantized corners so triangle winding and the
            // starting vertex don't affect the hash — only the (multiset of)
            // positions and their adjacency as a triangle.
            let mut tri = [
                self.quantize_corner(&world[0]),
                self.quantize_corner(&world[1]),
                self.quantize_corner(&world[2]),
            ];
            tri.sort_unstable();

            // Skip degenerate (zero-area) triangles. After quantization,
            // coincident or colinear corners carry no shape signal, and
            // counting them lets triangulation noise (sliver/zero-area faces)
            // flip the fingerprint even when the rendered geometry is
            // unchanged. `edge_cross` returns `None` for exactly those.
            let Some(cross) = surface::edge_cross(&tri) else {
                continue;
            };

            // Channel 1 — the vertex SET: every corner of every surviving
            // triangle, deduplicated. A retriangulation reconnects the same
            // corners, so this is exactly what it cannot move.
            for corner in tri {
                if self.vertices.insert(corner) {
                    self.vertex_accum = self.vertex_accum.wrapping_add(vertex_hash(&corner));
                }
            }

            // Channel 2 — area per supporting plane. The vertex set alone
            // cannot see a face deleted from between corners other faces still
            // use; the area can, and a retriangulation leaves it untouched.
            let plane = plane_of(cross, &tri[0]);
            self.plane_area_accum = self
                .plane_area_accum
                .wrapping_add(plane.key.wrapping_mul(plane.weight as u64));

            self.triangle_count = self.triangle_count.wrapping_add(1);
        }

        // A call that contributed no in-range triangle is not a segment: it has
        // no geometry, so its verdict says nothing about the element.
        if vol_ref.is_none() {
            return;
        }
        self.closure.fold_segment(&verdict);
        self.volume6 += seg_volume6;
    }
}
