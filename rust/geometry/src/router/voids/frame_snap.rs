// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Re-planarise the operands of a wall-local-frame cut (#5635).
//!
//! A plan-rotated wall reaches the void path as f32 world positions. Rotating
//! those into the wall frame (#1167) makes every face axis-aligned only up to
//! the world f32 quantum: at 60 m from the origin one face of an 80 mm layer
//! lands on ~50 distinct depth values spread over ~8 µm. The exact kernel and
//! the coplanar merge then see many near-parallel planes where the authored
//! wall has one, and the cut keeps T-junction seams along them (52 open
//! directed edges on the #5410 reporter's curtain-wall layer, 0 on the
//! axis-aligned twin of the same wall, which never leaves exact world axes).
//!
//! The fix restores the invariant the frame exists for: per frame axis, every
//! coordinate of the host and its cutters within the world quantum of another
//! is moved to one shared value. Coordinates that differ by more than that are
//! untouched, so real features are never merged.

use super::OpeningType;
use crate::{Mesh, Point3};

/// Coordinates closer than this many f32 ULPs of the world magnitude are one
/// value. Rotation of a quantised point moves it by up to ~1 ULP per axis;
/// the margin covers the sum over the three world components.
const QUANTUM_ULPS: f64 = 4.0;

/// The f32 quantum of world coordinates of magnitude `world_magnitude`, times
/// [`QUANTUM_ULPS`]: the tolerance [`snap_to_frame_planes`] clusters within.
pub(super) fn frame_snap_tolerance(world_magnitude: f64) -> f64 {
    QUANTUM_ULPS * f32::EPSILON as f64 * world_magnitude.max(1.0)
}

/// Per-axis clusters of nearby coordinate values: sorted `(first, last,
/// representative)` runs whose consecutive gaps are all `<= tol`.
struct AxisClusters(Vec<(f64, f64, f64)>);

impl AxisClusters {
    fn build(mut values: Vec<f64>, tol: f64) -> Self {
        values.retain(|v| v.is_finite());
        values.sort_by(f64::total_cmp);
        let mut runs = Vec::new();
        let mut start = 0;
        for i in 1..=values.len() {
            if i == values.len() || values[i] - values[i - 1] > tol {
                if i > start {
                    // The median member: a value that really occurs, and the
                    // same one whatever order the operands arrived in.
                    runs.push((values[start], values[i - 1], values[(start + i - 1) / 2]));
                }
                start = i;
            }
        }
        Self(runs)
    }

    fn snap(&self, v: f64) -> f64 {
        let i = self.0.partition_point(|&(_, last, _)| last < v);
        match self.0.get(i) {
            Some(&(first, last, rep)) if first <= v && v <= last => rep,
            _ => v,
        }
    }
}

/// Move every coordinate of `host` and of each opening's cutter mesh and
/// bounds, per frame axis, onto the shared representative of its cluster.
/// All operands are expressed in the same wall frame.
pub(super) fn snap_to_frame_planes(host: &mut Mesh, openings: &mut [OpeningType], tol: f64) {
    let mut per_axis: [Vec<f64>; 3] = Default::default();
    let collect_mesh = |m: &Mesh, per_axis: &mut [Vec<f64>; 3]| {
        for c in m.positions.chunks_exact(3) {
            for k in 0..3 {
                per_axis[k].push(c[k] as f64);
            }
        }
    };
    collect_mesh(host, &mut per_axis);
    for op in openings.iter() {
        let (mesh, lo, hi) = parts(op);
        if let Some(m) = mesh {
            collect_mesh(m, &mut per_axis);
        }
        for k in 0..3 {
            per_axis[k].push(lo[k]);
            per_axis[k].push(hi[k]);
        }
    }
    let clusters = per_axis.map(|values| AxisClusters::build(values, tol));

    let snap_mesh = |m: &mut Mesh| {
        for c in m.positions.chunks_exact_mut(3) {
            for k in 0..3 {
                c[k] = clusters[k].snap(c[k] as f64) as f32;
            }
        }
    };
    let snap_point = |p: &mut Point3<f64>| {
        for k in 0..3 {
            p[k] = clusters[k].snap(p[k]);
        }
    };
    snap_mesh(host);
    for op in openings.iter_mut() {
        match op {
            OpeningType::Rectangular(lo, hi, _) => {
                snap_point(lo);
                snap_point(hi);
            }
            OpeningType::NonRectangular(m, lo, hi, _) => {
                snap_mesh(m);
                snap_point(lo);
                snap_point(hi);
            }
            OpeningType::DiagonalRectangular(m, _) => snap_mesh(m),
        }
    }
}

fn parts(op: &OpeningType) -> (Option<&Mesh>, Point3<f64>, Point3<f64>) {
    match op {
        OpeningType::Rectangular(lo, hi, _) => (None, *lo, *hi),
        OpeningType::NonRectangular(m, lo, hi, _) => (Some(m), *lo, *hi),
        OpeningType::DiagonalRectangular(m, _) => {
            let (lo, hi) = m.bounds();
            (
                Some(m),
                Point3::new(lo.x as f64, lo.y as f64, lo.z as f64),
                Point3::new(hi.x as f64, hi.y as f64, hi.z as f64),
            )
        }
    }
}

#[cfg(test)]
#[path = "frame_snap_tests.rs"]
mod tests;
