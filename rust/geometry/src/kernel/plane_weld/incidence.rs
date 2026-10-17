// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Preserve originally exact, overlapping source/host face planes (#7292).
//!
//! A source corner can lie outside the finite host triangle while its incident
//! source face overlaps that host with positive area. Welding the corner onto
//! another nearby plane must not tilt that already shared surface away. This
//! records actual face overlap, rather than incidental infinite-plane hits.
//! It preserves supporting planes; topology and filled coverage are separately
//! checked by the real-model census and oracle.

use crate::kernel::{
    arrangement::Tri,
    broadphase::{tri_aabb, Bvh},
    predicates::{orient2d, orient3d_explicit},
    retriangulate::projection_axis,
    ImplicitPoint, Sign,
};
use rustc_hash::FxHashMap;

pub(super) fn point_key(point: [f64; 3]) -> [u64; 3] {
    // Exact predicates identify both signs of zero as the same coordinate.
    point.map(|value| if value == 0.0 { 0 } else { value.to_bits() })
}

fn on_plane(point: [f64; 3], plane: &Tri) -> bool {
    orient3d_explicit(point, plane[0], plane[1], plane[2]) == Sign::Zero
}

fn positive_overlap(a: &Tri, b: &Tri) -> bool {
    let Some((axis, wa)) = projection_axis(a) else {
        return false;
    };
    let e = ImplicitPoint::Explicit;
    let wb = orient2d(&e(b[0]), &e(b[1]), &e(b[2]), axis);
    if wb == Sign::Zero {
        return false;
    }
    // Strict separating-axis test: both triangles have positive projected area.
    // Point/edge-only contact has a separating edge with no interior vertex.
    [(a, b, wa), (b, a, wb)].iter().all(|&(host, other, winding)| {
        (0..3).all(|i| other.iter().any(|&p| {
            orient2d(&e(host[i]), &e(host[(i + 1) % 3]), &e(p), axis) == winding
        }))
    })
}

pub(super) struct ExactFaceIncidences {
    planes: FxHashMap<[u64; 3], Vec<usize>>,
}

impl ExactFaceIncidences {
    pub(super) fn new(source: &[Tri], host: &[Tri]) -> Self {
        let mut planes: FxHashMap<[u64; 3], Vec<usize>> = FxHashMap::default();
        let tree = Bvh::build(host);
        let mut candidates = Vec::new();
        for s in source {
            candidates.clear();
            tree.query(&tri_aabb(s), &mut candidates);
            candidates.sort_unstable();
            for &index in &candidates {
                let hi = index as usize;
                let h = &host[hi];
                if s.iter().all(|&p| on_plane(p, h)) && positive_overlap(h, s) {
                    for point in s {
                        let faces = planes.entry(point_key(*point)).or_default();
                        if !faces.contains(&hi) {
                            faces.push(hi);
                        }
                    }
                    // A nondegenerate source triangle defines one plane. Every
                    // qualifying host match has that exact plane, so one is
                    // enough. At most three registrations per source triangle
                    // keeps storage linear even on dense coplanar surfaces.
                    break;
                }
            }
        }
        Self { planes }
    }

    pub(super) fn admits(&self, original: [f64; 3], target: [f64; 3], host: &[Tri]) -> bool {
        self.planes.get(&point_key(original)).is_none_or(|planes| {
            planes.iter().all(|&i| on_plane(target, &host[i]))
        })
    }
}

#[cfg(test)]
#[path = "incidence_tests.rs"]
mod tests;
