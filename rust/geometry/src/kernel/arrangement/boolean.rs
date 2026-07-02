// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::super::interner::{Interner, Vid};
use super::super::rational::point_of;
use super::classify::{
    boolean_vids, boolean_vids_components, cross3, operand_extent, point_inside, rotate_min_first,
    sub_f64, to_f64_pt, BComponents,
};
use super::{arrange, arrange_many, BoolOp, MultiArrangement, Tri};
use num_traits::ToPrimitive;

/// `∪ meshes` as a watertight triangle list — the N-ary union.
///
/// Computed in ONE conforming arrangement ([`arrange_many`]), so it never re-meshes
/// an intermediate union (which is what makes left-deep pairwise accumulation tear
/// along coplanar seams shared by 3+ operands — the #960 segmented-roof cutters).
///
/// A sub-triangle of mesh `k` is on `∂(∪meshes)` iff its OUTER side (`+n`) lies
/// outside every other mesh. Identical co-oriented faces shared by several meshes
/// (e.g. duplicated cutter prisms) are kept once, owned by the LOWEST mesh index.
pub fn union_all(meshes: &[&[Tri]]) -> Vec<Tri> {
    if meshes.is_empty() {
        return Vec::new();
    }
    if meshes.len() == 1 {
        return meshes[0].to_vec();
    }
    use std::collections::HashMap;
    let arr = arrange_many(meshes);
    let exts: Vec<f64> = meshes.iter().map(|m| operand_extent(m)).collect();
    // Owner map: oriented (winding-preserving) Vid key → lowest mesh index that
    // KEEPS that face. A later mesh's identical co-oriented copy is dropped.
    let mut owner: HashMap<[Vid; 3], usize> = HashMap::new();
    // First pass: decide keep per sub-triangle (boundary of the union), recording
    // the canonical owner of each kept oriented face.
    let mut keep: Vec<Vec<bool>> = Vec::with_capacity(meshes.len());
    for (k, sub) in arr.subtris.iter().enumerate() {
        let mut kk = Vec::with_capacity(sub.len());
        for &tri in sub {
            let c = centroid_multi(&arr, tri);
            let n = tri_normal_multi(&arr, tri);
            // outer side just past the face along +n
            let outer = offset_point(c, n, exts[k]);
            // on the union boundary iff the outer side is outside ALL other meshes
            let on_boundary = (0..meshes.len())
                .filter(|&m| m != k)
                .all(|m| !point_inside(outer, meshes[m], exts[m]));
            let mut keep_this = on_boundary;
            if keep_this {
                let key = rotate_min_first(tri);
                match owner.get(&key) {
                    Some(&o) if o != k => keep_this = false, // duplicate; earlier mesh owns it
                    _ => {
                        owner.entry(key).or_insert(k);
                    }
                }
            }
            kk.push(keep_this);
        }
        keep.push(kk);
    }
    // Materialize kept sub-triangles to f64.
    let mut out = Vec::new();
    for (k, sub) in arr.subtris.iter().enumerate() {
        for (t, &tri) in sub.iter().enumerate() {
            if keep[k][t] {
                out.push([
                    point_via_interner(&arr.interner, tri[0]),
                    point_via_interner(&arr.interner, tri[1]),
                    point_via_interner(&arr.interner, tri[2]),
                ]);
            }
        }
    }
    out
}

/// Step `step·n̂` off `c` along the unit-normalised `dir`. Deterministic FMA-free
/// f64 (mirrors [`solid_side`]'s probe).
fn offset_point(c: [f64; 3], dir: [f64; 3], far_l: f64) -> [f64; 3] {
    let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
    if len == 0.0 {
        return c;
    }
    let step = far_l * (1.0 / 1_048_576.0);
    [
        c[0] + dir[0] / len * step,
        c[1] + dir[1] / len * step,
        c[2] + dir[2] / len * step,
    ]
}

/// Centroid of a multi-arrangement sub-triangle (interner lookup).
fn centroid_multi(arr: &MultiArrangement, tri: [Vid; 3]) -> [f64; 3] {
    let c = [
        point_via_interner(&arr.interner, tri[0]),
        point_via_interner(&arr.interner, tri[1]),
        point_via_interner(&arr.interner, tri[2]),
    ];
    [
        (c[0][0] + c[1][0] + c[2][0]) / 3.0,
        (c[0][1] + c[1][1] + c[2][1]) / 3.0,
        (c[0][2] + c[1][2] + c[2][2]) / 3.0,
    ]
}

fn tri_normal_multi(arr: &MultiArrangement, tri: [Vid; 3]) -> [f64; 3] {
    let (a, b, c) = (
        point_via_interner(&arr.interner, tri[0]),
        point_via_interner(&arr.interner, tri[1]),
        point_via_interner(&arr.interner, tri[2]),
    );
    cross3(sub_f64(b, a), sub_f64(c, a))
}

#[inline]
fn point_via_interner(it: &Interner, v: Vid) -> [f64; 3] {
    let pt = it.get(v);
    if let Some(f) = super::super::fixed::point_to_f64(pt) {
        return f;
    }
    let p = point_of(pt);
    [p[0].to_f64().unwrap(), p[1].to_f64().unwrap(), p[2].to_f64().unwrap()]
}

/// Compute the boolean `op` of operand meshes `a` and `b`, materialised to f64
/// triangles. `A−B = (A outside B) ∪ flip(B inside A)`;
/// `A∪B = (A outside B) ∪ (B outside A)`; `A∩B = (A inside B) ∪ (B inside A)`.
pub fn boolean(a: &[Tri], b: &[Tri], op: BoolOp) -> Vec<Tri> {
    let arr = arrange(a, b);
    let vids = boolean_vids(&arr, a, b, op);
    vids.into_iter()
        .map(|t| [to_f64_pt(&arr, t[0]), to_f64_pt(&arr, t[1]), to_f64_pt(&arr, t[2])])
        .collect()
}

/// `a − (∪ comps)` for PAIRWISE-DISJOINT, per-component-closed, OUTWARD-wound
/// cutter components, computed in ONE conforming arrangement (disjoint-cutter
/// batching).
///
/// Soundness: `arrange` only intersects A×B pairs, and disjoint B components
/// have no B×B intersections to miss; classification decomposes per component
/// (`BComponents`). The #2176 lesson is a PRECONDITION here: every component
/// must be closed and outward-wound on its own — the caller (`mesh_bridge::
/// subtract_many`) orients each component before concatenation, and the router
/// only admits per-component-watertight cutters to a batch.
///
/// vs. sequential per-cutter subtraction this avoids re-arranging the (growing)
/// host once per cutter — each intermediate round-trip through f32 + the snap
/// grid re-jitters carve vertices off shared planes, so cut N+1 re-cracks what
/// cut N reconciled (many-void walls' compounding open edges) — and is
/// ~N× cheaper on N box cutters.
pub fn difference_all(a: &[Tri], comps: &[&[Tri]]) -> Option<Vec<Tri>> {
    if comps.is_empty() {
        return Some(a.to_vec());
    }
    let b_all: Vec<Tri> = comps.iter().flat_map(|c| c.iter().copied()).collect();
    let arr = arrange(a, &b_all);
    // Hard conformity gate (unlike the binary `boolean`'s graceful degrade):
    // an unrecovered constraint means some sub-triangle STRADDLES a cutter
    // boundary and its centroid classification can silently over/under-cut
    // (the #559171 batched-door family: the jamb never carved into the back
    // face ⇒ −0.43 m³ and an open rim). The caller falls back to sequential
    // per-cutter subtraction, which carves few constraints per arrangement and
    // avoids the degenerate channel.
    if arr.unrecovered > 0 {
        return None;
    }
    let bc = BComponents::new(comps);
    let vids = boolean_vids_components(&arr, a, &bc, BoolOp::Difference);
    Some(
        vids.into_iter()
            .map(|t| [to_f64_pt(&arr, t[0]), to_f64_pt(&arr, t[1]), to_f64_pt(&arr, t[2])])
            .collect(),
    )
}

/// Topology fingerprint of a boolean result: each oriented Vid triangle rotated
/// min-first (canonical start vertex, winding preserved), the list sorted,
/// FNV-1a-hashed. Platform-stable — Vids are deterministic symbolic identities
/// and the ray-cast classification is FMA-free f64.
pub fn boolean_topology_hash(a: &[Tri], b: &[Tri], op: BoolOp) -> u64 {
    let arr = arrange(a, b);
    let mut tris: Vec<[Vid; 3]> =
        boolean_vids(&arr, a, b, op).into_iter().map(rotate_min_first).collect();
    tris.sort_unstable();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for t in tris {
        for v in t {
            h ^= v as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

/// Axis-aligned box `[lo,hi]` as 12 outward-wound triangles.
pub fn box_mesh(lo: [f64; 3], hi: [f64; 3]) -> Vec<Tri> {
    let p = [
        [lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
        [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]],
    ];
    let idx = [
        [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7],
        [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
        [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
    ];
    idx.iter().map(|f| [p[f[0]], p[f[1]], p[f[2]]]).collect()
}

/// Axis-aligned cube `[lo,hi]³`.
pub fn cube_mesh(lo: f64, hi: f64) -> Vec<Tri> {
    box_mesh([lo, lo, lo], [hi, hi, hi])
}

/// Cross-platform full-boolean determinism manifest: `cube[0,2]³ − cube[1,3]³`.
pub fn boolean_manifest() -> u64 {
    boolean_topology_hash(&cube_mesh(0.0, 2.0), &cube_mesh(1.0, 3.0), BoolOp::Difference)
}
