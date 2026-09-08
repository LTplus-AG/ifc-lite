// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `difference_result_looks_degenerate`, moved out of `csg/mod.rs` (which
//! sits at its module-size budget) to make room for #3440 step 2's
//! feature-gated topology check without raising the ratchet.

use super::ClippingProcessor;
use crate::mesh::Mesh;

impl ClippingProcessor {
    /// Heuristic: does this look like a botched CSG difference?
    ///
    /// Kernel-neutral check used by the boolean processor (e.g. the
    /// polygonal-bounded half-space clip) to fall back to a robust
    /// unbounded plane clip when a difference result looks collapsed
    /// relative to its host. Historically this caught a Linux-specific
    /// Manifold pathology where a wall body clipped by an
    /// `IfcPolygonalBoundedHalfSpace` prism collapsed to a near-empty
    /// result (1 triangle from a 12-triangle host box).
    ///
    /// Rules:
    ///  * An empty result is a legit outcome (cutter contains host) —
    ///    NOT degenerate.
    ///  * A closed-volume result needs at least 4 triangles. Anything
    ///    below that is structurally broken.
    ///  * For hosts with >= 12 triangles (typical IFC solid input), the
    ///    output should retain at least 25 % of the host's triangle
    ///    count when the cutter is partial.
    pub(crate) fn difference_result_looks_degenerate(host: &Mesh, result: &Mesh) -> bool {
        let result_tris = result.indices.len() / 3;
        if result_tris == 0 {
            return false;
        }
        if result_tris < 4 {
            return true;
        }
        let host_tris = host.indices.len() / 3;
        if host_tris >= 12 && result_tris * 4 < host_tris {
            return true;
        }

        // "Wrong piece" check: a difference result MUST be a subset of the
        // host volume, so the result's bounding box has to sit inside the
        // host's. When a malformed cutter (typical: IfcFacetedBrep with
        // inward-pointing face normals) inverts the kernel's
        // inside/outside test, Manifold returns the CUTTER mesh instead —
        // which lives partially or wholly outside the host bbox. House.ifc
        // wall #3448 (a 7 m extrusion clipped by a gable-shaped brep)
        // rendered as the gable triangle alone before this guard.
        let (host_min, host_max) = host.bounds();
        let (res_min, res_max) = result.bounds();
        // 1 % of the host's edge **per axis** — using a single tolerance
        // derived from the longest dimension lets thin walls/plates pass
        // a wrong-piece check on Y/Z that they shouldn't (CodeRabbit
        // review on PR #861). With per-axis slack, a 5 m × 0.4 m × 7 m
        // wall gets ±5 cm tolerance on X, ±4 mm on Y, ±7 cm on Z — so a
        // result that pokes >4 mm past the wall's thickness face is
        // correctly flagged even though it's well within 1 % of the X
        // span.
        let slack = (host_max - host_min).abs() * 0.01;
        if res_min.x + slack.x < host_min.x
            || res_min.y + slack.y < host_min.y
            || res_min.z + slack.z < host_min.z
            || res_max.x > host_max.x + slack.x
            || res_max.y > host_max.y + slack.y
            || res_max.z > host_max.z + slack.z
        {
            return true;
        }
        false
    }
}
