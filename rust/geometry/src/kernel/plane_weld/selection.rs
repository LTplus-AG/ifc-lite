// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Select an actual covering host surface before an unrelated support plane.

use super::lift::exact_on_plane_weld;
use crate::kernel::{
    arrangement::Tri,
    coplanar::contains_projected_point,
    near_band::{vertex_bits, NearBand},
    predicates::orient3d,
    ImplicitPoint, Sign,
};
use std::collections::HashSet;

pub(super) struct Face {
    pub(super) t: Tri,
    n: [f64; 3],
    pub(super) nn: f64,
    pub(super) band2: f64,
}

impl Face {
    pub(super) fn new(t: Tri, band: &NearBand) -> Option<Self> {
        let u = [0, 1, 2].map(|k| t[1][k] - t[0][k]);
        let v = [0, 1, 2].map(|k| t[2][k] - t[0][k]);
        let n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        let nn = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
        if nn <= 0.0 || !nn.is_finite() {
            return None;
        }
        Some(Self {
            t,
            n,
            nn,
            band2: band.scaled_band2(n, nn) / nn,
        })
    }

    pub(super) fn raw_offset(&self, point: &[f64; 3]) -> f64 {
         (point[0] - self.t[0][0]) * self.n[0]
            + (point[1] - self.t[0][1]) * self.n[1]
            + (point[2] - self.t[0][2]) * self.n[2]
    }

    fn distance(&self, point: [f64; 3]) -> (f64, f64) {
        let d = self.raw_offset(&point);
        (d * d / self.nn, d)
    }

    /// Use this selected face's original normal band, with no wider context.
    pub(super) fn outside_normal_band(&self, point: [f64; 3]) -> bool {
        let (distance2, _) = self.distance(point);
        distance2.is_finite() && distance2 > self.band2
    }

    pub(super) fn admits(
        &self,
        original: [f64; 3],
        w: [f64; 3],
        d: f64,
        band: &NearBand,
        host_vertices: &HashSet<[u64; 3], impl std::hash::BuildHasher>,
    ) -> bool {
        let scale = d / self.nn;
        let drift = [0, 1, 2].map(|k| w[k] - (original[k] - scale * self.n[k]));
        let drift2 = drift[0] * drift[0] + drift[1] * drift[1] + drift[2] * drift[2];
        if !drift2.is_finite() {
            return false;
        }
        if drift2 <= self.band2 {
            return true;
        }
        let tangent_band2 = band.scaled_band2(drift, drift2) / drift2;
        host_vertices.contains(&vertex_bits(&w))
            && tangent_band2.is_finite()
            && drift2 <= tangent_band2
    }
}

fn same_plane(a: &Tri, b: &Tri) -> bool {
    b.iter().all(|&p| {
        orient3d(
            &ImplicitPoint::Explicit(p),
            &ImplicitPoint::Explicit(a[0]),
            &ImplicitPoint::Explicit(a[1]),
            &ImplicitPoint::Explicit(a[2]),
        ) == Sign::Zero
    })
}

/// Closed projected support on the selected plane's finite triangle union.
/// Selection uses this for an off-plane probe's projection. A caller claiming
/// actual 3D contact must separately establish that its point is on `plane`.
/// Keep the selected triangle fast path and exact coplanar sibling semantics.
pub(super) fn projected_finite_support(point: [f64; 3], plane: &Tri, faces: &[Face]) -> bool {
    contains_projected_point(plane, point)
        || faces.iter().any(|f| {
            contains_projected_point(&f.t, point) && same_plane(plane, &f.t)
        })
}

/// The NEW fallback requires a genuine selected carrier. Its caller separately
/// proves exact point-on-plane; legacy selection keeps its projected semantics.
pub(super) fn projected_support_on_nondegenerate_plane(
    point: [f64; 3], plane: &Tri, faces: &[Face],
) -> bool {
    crate::kernel::retriangulate::projection_axis(plane).is_some()
        && projected_finite_support(point, plane, faces)
}

pub(super) fn select<'a>(
    point: [f64; 3],
    faces: &'a [Face],
    band: &NearBand,
    host_vertices: &HashSet<[u64; 3], impl std::hash::BuildHasher>,
) -> Option<(f64, &'a Face)> {
    let mut nearest: Option<(f64, f64, &Face)> = None;
    for face in faces {
        let (distance2, d) = face.distance(point);
        if d == 0.0 || distance2 > face.band2 {
            continue;
        }
        if nearest.is_none_or(|(old, ..)| distance2 < old) {
            nearest = Some((distance2, d, face));
        }
    }
    let (_, original_d, original) = nearest?;
    let Some(original_q20) = exact_on_plane_weld(point, original.t) else {
        return Some((original_d, original));
    };
    // Correct an already admitted reconciliation's surface incidence. Refused
    // Q20 lifts retain their established bounded axis-rescue path unchanged.
    if !original.admits(point, original_q20, original_d, band, host_vertices)
        || host_vertices.contains(&vertex_bits(&original_q20))
    {
        return Some((original_d, original));
    }
    if projected_finite_support(point, &original.t, faces) {
        return Some((original_d, original));
    }
    let mut covering: Option<(f64, f64, &Face)> = None;
    for face in faces {
        let (distance2, d) = face.distance(point);
        if d == 0.0
            || distance2 > face.band2
            || covering.is_some_and(|(old, ..)| distance2 >= old)
            || !contains_projected_point(&face.t, point)
        {
            continue;
        }
        if exact_on_plane_weld(point, face.t)
            .is_some_and(|q| face.admits(point, q, d, band, host_vertices))
        {
            covering = Some((distance2, d, face));
        }
    }
    // Infinite supporting planes remain eligible when no covering face admits
    // an exact lift; flush opening extensions still rely on that behavior.
    Some(covering.map_or((original_d, original), |(_, d, f)| (d, f)))
}

#[cfg(test)]
#[path = "selection_tests.rs"]
mod tests;
