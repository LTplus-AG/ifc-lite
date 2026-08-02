// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#![no_main]

use ifc_lite_geometry::{triangulate_polygon, Point2};
use libfuzzer_sys::fuzz_target;

// Real IFC profiles come from untrusted STEP/IFCX authoring tools and can
// carry NaN/Inf coordinates, duplicate/collinear points, or self-intersecting
// rings (see the safe_earcut doc comment on the Revit->Bonsai wedge case,
// triangulation.rs). This target feeds triangulate_polygon arbitrary f64 bit
// patterns directly (no finite-only pre-filter) so libFuzzer can explore the
// NaN/Inf/degenerate space itself.
//
// Capped point count keeps every iteration fast: the fan/CDT/earcut paths are
// all near-linear in point count, so a handful of points is enough to reach
// every branch (triangle/quad/convex fast paths, and the >8-point earcutr
// fallback) without spending fuzzing budget on huge polygons.
const MAX_POINTS: usize = 32;

fn points_from_bytes(data: &[u8]) -> Vec<Point2<f64>> {
    data.chunks_exact(16)
        .take(MAX_POINTS)
        .map(|c| {
            let x = f64::from_le_bytes(c[0..8].try_into().expect("8-byte chunk"));
            let y = f64::from_le_bytes(c[8..16].try_into().expect("8-byte chunk"));
            Point2::new(x, y)
        })
        .collect()
}

// Contract under fuzz: triangulating an arbitrary point set must never panic,
// hang, or overflow the stack; it may only return Ok or Err. The return value
// is intentionally discarded; libFuzzer drives input coverage.
fuzz_target!(|data: &[u8]| {
    let points = points_from_bytes(data);
    let _ = triangulate_polygon(&points);
});
