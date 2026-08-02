// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cut-skip heuristics for boolean DIFFERENCE operations: preview-tier
//! small-cut dropping (#1286) and the host-face coincidence test that gates
//! half-space plane clips.

use crate::{Mesh, Point3, TessellationQuality, Vector3};

/// Whether this tessellation tier drops sub-threshold boolean cuts (preview
/// tiers only). `Medium` (the default) and finer keep every cut, so their
/// geometry is byte-identical to before this optimization.
pub(super) fn quality_skips_small_cuts(quality: TessellationQuality) -> bool {
    matches!(quality, TessellationQuality::Lowest | TessellationQuality::Low)
}

/// Skip ratio for preview-mode small-cut dropping: cutter max-dimension as a
/// fraction of host max-dimension. Default 0.10 (≈ Manifold-era load times on
/// the steel corpus with no visible change to members). Native callers can tune
/// it via `IFC_LITE_FAST_CUT_RATIO`; in wasm (no env) the default applies.
pub(super) fn fast_cut_skip_ratio() -> f64 {
    use std::sync::OnceLock;
    static R: OnceLock<f64> = OnceLock::new();
    *R.get_or_init(|| {
        std::env::var("IFC_LITE_FAST_CUT_RATIO")
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.10)
    })
}

/// True when `cutter`'s largest bounding-box dimension is below
/// [`fast_cut_skip_ratio`] of `host`'s — i.e. a small local cut worth skipping in
/// the preview tiers. Degenerate (zero-extent) hosts never skip.
pub(super) fn cutter_below_skip_ratio(host: &Mesh, cutter: &Mesh) -> bool {
    let max_dim = |m: &Mesh| -> f64 {
        let (mn, mx) = m.bounds();
        (((mx.x - mn.x) as f64).max((mx.y - mn.y) as f64)).max((mx.z - mn.z) as f64)
    };
    let h = max_dim(host);
    if h <= 0.0 {
        return false;
    }
    max_dim(cutter) / h < fast_cut_skip_ratio()
}

/// Decide whether `plane` (point + outward normal) is coincident with one
/// of the host mesh's axis-aligned bounding-box faces. The check tolerates
/// numerical noise scaled to the host's diagonal so it works for both
/// metre-scale residential walls and millimetre-scale connector hardware.
pub(super) fn plane_is_coincident_with_host_face(
    host: &Mesh,
    plane_point: Point3<f64>,
    plane_normal: Vector3<f64>,
) -> bool {
    let (mn, mx) = host.bounds();
    let host_min = Point3::new(mn.x as f64, mn.y as f64, mn.z as f64);
    let host_max = Point3::new(mx.x as f64, mx.y as f64, mx.z as f64);
    let dx = host_max.x - host_min.x;
    let dy = host_max.y - host_min.y;
    let dz = host_max.z - host_min.z;
    let diag = (dx * dx + dy * dy + dz * dz).sqrt();
    if diag <= 0.0 {
        return false;
    }
    // 0.1 % of host diagonal, but never less than 1 mm. A 4 m wall ⇒ 4 mm;
    // a 20 mm fastener ⇒ 1 mm. Tight enough to reject planes that are
    // unambiguously *outside* the host (the "intentional engulf" case)
    // while still catching the Revit top-trim that lands exactly on the
    // wall's top face within float-precision noise.
    let tol = (diag * 0.001).max(0.001);

    // Test all 8 bbox corners against the plane. If ANY corner is within
    // `tol` of the plane, the plane is touching (or near-coincident with)
    // a face. This catches axis-aligned faces (4 corners hit), as well as
    // edges (2 corners hit) and even single-vertex grazes — all of which
    // signal that the cut author meant the plane to ride the host surface,
    // not engulf the body from far away.
    let corners = [
        Point3::new(host_min.x, host_min.y, host_min.z),
        Point3::new(host_max.x, host_min.y, host_min.z),
        Point3::new(host_min.x, host_max.y, host_min.z),
        Point3::new(host_max.x, host_max.y, host_min.z),
        Point3::new(host_min.x, host_min.y, host_max.z),
        Point3::new(host_max.x, host_min.y, host_max.z),
        Point3::new(host_min.x, host_max.y, host_max.z),
        Point3::new(host_max.x, host_max.y, host_max.z),
    ];
    for c in &corners {
        let signed = (c - plane_point).dot(&plane_normal);
        if signed.abs() <= tol {
            return true;
        }
    }
    false
}
