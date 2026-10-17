// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Preserve healthy original axis-face coordinates during admitted Q20 lifts.
//! This revises quantization only; eligibility and all existing fallbacks stay
//! in the caller. Build once from the original source, before deferred writes.
//! Geometrically coincident corners share constraints across both signs of zero;
//! the caller retains its separate raw proposal and rejection identities.

use super::incidence::point_key;
use super::lift::on_existing_vertex_grid;
use crate::kernel::{
    arrangement::Tri,
    coplanar::contains_projected_point,
    near_band::vertex_bits,
    predicates::{orient2d_any, orient3d_explicit},
    retriangulate::projection_axis,
    DropAxis, ImplicitPoint, Sign,
};
#[cfg(test)]
use crate::kernel::predicates::orient3d;
use nalgebra::Point3;
use rustc_hash::FxHashMap;
use std::collections::HashSet;

pub(super) struct SourceAxes {
    axes: FxHashMap<[u64; 3], u8>,
}

impl SourceAxes {
    pub(super) fn new(source: &[Tri]) -> Self {
        let mut axes = FxHashMap::default();
        for t in source {
            let mut mask = 0;
            for k in 0..3 {
                if t[0][k] == t[1][k] && t[0][k] == t[2][k] {
                    mask |= 1 << k;
                }
            }
            // A non-axis face cannot register a coordinate, regardless of validity.
            if mask == 0 { continue; }
            // The SAME original face must survive both representations. Direct
            // callers and mutual promotion need not supply f32 input points.
            let narrowed = t.map(|p| p.map(|coordinate| coordinate as f32 as f64));
            if !t.iter().flatten().all(|coordinate| coordinate.is_finite())
                || !narrowed
                    .iter()
                    .flatten()
                    .all(|coordinate| coordinate.is_finite())
                || projection_axis(t).is_none()
                || projection_axis(&narrowed).is_none()
                || crate::csg::tri_is_needle(&t.map(Point3::from))
                || crate::csg::tri_is_needle(&narrowed.map(Point3::from))
            {
                continue;
            }
            if mask != 0 {
                for point in t {
                    *axes.entry(point_key(*point)).or_default() |= mask;
                }
            }
        }
        Self { axes }
    }

    /// A true perpendicular foot preserves coordinate k when n[k] is zero.
    /// Prove that independence exactly, rather than trusting a rounded normal.
    /// The caller must separately retain Face.admits and exact face incidences.
    pub(super) fn candidate(
        &self,
        original: [f64; 3],
        primary: [f64; 3],
        selected: Tri,
        host_vertices: &HashSet<[u64; 3]>,
    ) -> Option<[f64; 3]> {
        if host_vertices.contains(&vertex_bits(&primary)) {
            return None; // established host-corner identity is load-bearing
        }
        let mask = *self.axes.get(&point_key(original))?;
        let e = ImplicitPoint::Explicit;
        let mut candidate = primary;
        for (k, axis) in [DropAxis::X, DropAxis::Y, DropAxis::Z]
            .into_iter()
            .enumerate()
        {
            if mask & (1 << k) != 0
                && candidate[k] != original[k]
                && orient2d_any(&e(selected[0]), &e(selected[1]), &e(selected[2]), axis)
                    == Sign::Zero
            {
                candidate[k] = original[k];
            }
        }
        if vertex_bits(&candidate) == vertex_bits(&primary)
            || !on_existing_vertex_grid(candidate)
            || orient3d_explicit(candidate, selected[0], selected[1], selected[2]) != Sign::Zero
        {
            return None;
        }
        Some(candidate)
    }
}

/// Keep every exact finite host-triangle contact of the accepted primary.
/// Protect individual triangles conservatively, including internal diagonals.
/// Called only for an actual correction after all old admission checks pass.
pub(super) fn retains_finite_contacts(
    primary: [f64; 3],
    candidate: [f64; 3],
    host: &[Tri],
) -> bool {
    let on = |point, triangle: &Tri| {
        orient3d_explicit(point, triangle[0], triangle[1], triangle[2]) == Sign::Zero
            && contains_projected_point(triangle, point)
    };
    host.iter()
        .all(|triangle| !on(primary, triangle) || on(candidate, triangle))
}

#[cfg(test)]
#[path = "source_axes_tests.rs"]
mod tests;
