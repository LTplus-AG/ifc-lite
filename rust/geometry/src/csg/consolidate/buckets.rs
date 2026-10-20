// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Construct the ordered source-plane buckets before consolidation.
use super::plane_merge::{tag_for, PlaneTri};
use crate::{grid::NORMAL_QUANT_F64 as NORMAL_QUANT, mesh::Mesh};
use nalgebra::Point3;

pub(super) type BucketKey = (i64, i64, i64, i64);
pub(super) type Buckets = std::collections::BTreeMap<BucketKey, Vec<PlaneTri>>;

pub(super) fn build(mesh: &Mesh) -> Buckets {
    // Quantization for plane bucketing — normals are coarser (1e3) than
    // positions because cross-product noise on near-coplanar tris can
    // wobble in the 6th decimal; offsets get the same coarsening so
    // bucket keys stay aligned with normal direction.
    //
    // NB (issue #1007): the offset key is deliberately FINE (1 µm) and must
    // NOT be coarsened. The exact-kernel opening cut on a faceted-BREP roof
    // emits the hole-boundary triangles on planes that jitter ~25–150 µm;
    // that jitter is what keeps each on its own bucket. Coalescing them (a
    // coarser offset grid, or projecting the whole roof slope to ONE canonical
    // plane) lets the i_overlay UNION close the opening hole — a bridging facet
    // over the footprint, caught by `issue_1007_real_opening_no_bridge`.
    const POS_QUANT: f64 = 1.0e6;
    let qpos = |p: f64| (p * POS_QUANT).round() as i64;
    let qnorm = |n: f64| (n * NORMAL_QUANT).round() as i64;

    // Step 1 — group input triangles by plane.
    let positions = &mesh.positions;
    let vertex_count = positions.len() / 3;
    let triangle_count = mesh.indices.len() / 3;
    let plane_tags = mesh.plane_tags.as_deref();
    // BTreeMap, NOT FxHashMap: step 2 emits the output mesh in bucket
    // iteration order, and FxHasher mixes usize-wide chunks, so its
    // iteration order differs between 64-bit native and 32-bit wasm32 -
    // the same cut came out with a different (valid but non-identical)
    // triangle order per target, breaking the native==wasm mesh-output
    // determinism manifest. Ord-keyed iteration is target-independent
    // (same pattern as facet_weld's normal_buckets); bucket counts per
    // cut are small, so the tree overhead is noise.
    //
    // Bucketing itself is UNCHANGED (today's geometric re-derivation):
    // #3914's fix is a separate merge pass below, not a different key
    // here — see that pass for why.
    let mut buckets = Buckets::new();
    for (tri_idx, chunk) in mesh.indices.chunks_exact(3).enumerate() {
        let (i0, i1, i2) = (chunk[0] as usize, chunk[1] as usize, chunk[2] as usize);
        if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
            continue;
        }
        let v0 = Point3::new(
            positions[i0 * 3] as f64,
            positions[i0 * 3 + 1] as f64,
            positions[i0 * 3 + 2] as f64,
        );
        let v1 = Point3::new(
            positions[i1 * 3] as f64,
            positions[i1 * 3 + 1] as f64,
            positions[i1 * 3 + 2] as f64,
        );
        let v2 = Point3::new(
            positions[i2 * 3] as f64,
            positions[i2 * 3 + 1] as f64,
            positions[i2 * 3 + 2] as f64,
        );
        let edge1 = v1 - v0;
        let edge2 = v2 - v0;
        let cross = edge1.cross(&edge2);
        let len = cross.norm();
        if len < 1.0e-10 {
            continue;
        }
        let normal = cross / len;
        let offset = normal.dot(&v0.coords);
        let key = (
            qnorm(normal.x),
            qnorm(normal.y),
            qnorm(normal.z),
            qpos(offset),
        );
        let tri_v = [v0, v1, v2];
        let tag = tag_for(plane_tags, triangle_count, tri_idx, &tri_v);
        buckets.entry(key).or_default().push(PlaneTri {
            v: tri_v,
            normal,
            tag,
        });
    }
    buckets
}
