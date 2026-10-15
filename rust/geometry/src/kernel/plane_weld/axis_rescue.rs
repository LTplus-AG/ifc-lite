// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Complete independent axis-plane incidences after a bounded axis-foot rescue.

use super::lift::{exact_axis_plane_foot, exact_on_plane_weld};
use crate::kernel::{arrangement::Tri, near_band::vertex_bits};
use std::collections::HashSet;

pub(super) struct AxisPlane {
    axis: usize,
    value: f64,
    band2: f64,
    tri: Tri,
}

impl AxisPlane {
    /// The caller supplies only its cached nondegenerate host faces.
    pub(super) fn new(tri: Tri, band2: f64) -> Option<Self> {
        let axis = (0..3).find(|&k| tri[0][k] == tri[1][k] && tri[0][k] == tri[2][k])?;
        Some(Self { axis, value: tri[0][axis], band2, tri })
    }
}

/// Each step changes one coordinate within that face's original normal band.
/// Independent axes preserve every already established axis-plane incidence;
/// each axis is considered once, so parallel planes cannot make this oscillate.
pub(super) fn complete_axis_rescue(
    mut point: [f64; 3],
    planes: &[AxisPlane],
    host_vertices: &HashSet<[u64; 3]>,
) -> [f64; 3] {
    let mut resolved = [false; 3];
    for plane in planes {
        if point[plane.axis] == plane.value {
            resolved[plane.axis] = true;
        }
    }
    // The initial rescue has already established at least one axis plane.
    for _ in 0..2 {
        if host_vertices.contains(&vertex_bits(&point)) {
            break; // retain the shared-vertex protection (#3353)
        }
        let mut best: Option<(f64, &AxisPlane)> = None;
        for plane in planes {
            if resolved[plane.axis] { continue; }
            let offset = point[plane.axis] - plane.value;
            let distance2 = offset * offset;
            if !distance2.is_finite() || distance2 > plane.band2 { continue; }
            if best.is_none_or(|(old, _)| distance2 < old) {
                best = Some((distance2, plane)); // face-order ties stay stable
            }
        }
        let Some((_, plane)) = best else { break };
        resolved[plane.axis] = true;
        // Keep the original lift's host-grid, range, Gram and round-trip gates.
        if exact_on_plane_weld(point, plane.tri).is_some() {
            if let Some(foot) = exact_axis_plane_foot(point, plane.tri) {
                point = foot; // zero tangential displacement for this step
            }
        }
    }
    point
}
