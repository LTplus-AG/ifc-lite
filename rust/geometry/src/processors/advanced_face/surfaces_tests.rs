// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression coverage for the #4901 B-spline degree / control-point bounds.
//! Split out per the house pattern (`stream_meta.rs`) rather than inlined,
//! so `surfaces.rs` stays under the module-size ratchet.

use super::*;
use ifc_lite_core::EntityDecoder;
use std::time::{Duration, Instant};

/// A degenerate but well-formed 3x3-control-point, degree-2 B-spline surface:
/// UDegree=2, VDegree=2, 6 knots per axis (3 control points + degree + 1).
fn small_surface_content(u_degree: usize, v_degree: usize) -> String {
    format!(
        r#"
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((1.,0.,1.));
#3=IFCCARTESIANPOINT((2.,0.,0.));
#4=IFCCARTESIANPOINT((0.,1.,1.));
#5=IFCCARTESIANPOINT((1.,1.,2.));
#6=IFCCARTESIANPOINT((2.,1.,1.));
#7=IFCCARTESIANPOINT((0.,2.,0.));
#8=IFCCARTESIANPOINT((1.,2.,1.));
#9=IFCCARTESIANPOINT((2.,2.,0.));
#10=IFCBSPLINESURFACEWITHKNOTS({u_degree},{v_degree},((#1,#2,#3),(#4,#5,#6),(#7,#8,#9)),.UNSPECIFIED.,.F.,.F.,.F.,(3,3),(3,3),(0.,1.),(0.,1.),.UNSPECIFIED.);
"#
    )
}

/// A single-axis moderate-but-legitimate-shaped degree against a MATCHING
/// knot vector (one multiplicity entry covering the whole `n + degree + 1`
/// requirement) — the shape that made the OLD naive, non-memoized
/// `bspline_basis` recursion (`O(2^degree)` per basis function, called once
/// per control point per sample point with NO caching across calls) run
/// long past any usable time at `degree` in the tens, well under
/// [`MAX_BSPLINE_DEGREE`]. Exercises the actual perf fix, not just the cap.
fn moderate_degree_surface_content(degree: usize) -> String {
    let n = degree + 14; // comfortably keeps degree < n (well-formed)
    let u_knot_count = n + degree + 1;
    let points: String = (1..=n)
        .map(|i| format!("#{i}=IFCCARTESIANPOINT(({}.,0.,{}.));\n", i, i % 2))
        .collect();
    // U axis: `n` rows, each a single-point row (n_u = n). V axis: degree 0,
    // one point per row (n_v = 1), knots (0., 0.) via multiplicity 2.
    let rows = (1..=n).map(|i| format!("(#{i})")).collect::<Vec<_>>().join(",");
    let surface_id = n + 1;
    format!(
        "{points}#{surface_id}=IFCBSPLINESURFACEWITHKNOTS({degree},0,({rows}),.UNSPECIFIED.,.F.,.F.,.F.,({u_knot_count}),(2),(0.),(0.),.UNSPECIFIED.);\n"
    )
}

/// #4901: a degree well under [`MAX_BSPLINE_DEGREE`], paired with a knot
/// vector that actually satisfies it (so neither guard bails early), must
/// still tessellate fast — proving the memoized `bspline_basis_table` (not
/// just the degree cap) is what closed the hang, since a degree this size
/// clears every cap comfortably while still being exponential (`2^40`) under
/// the old naive recursion.
#[test]
fn moderate_degree_with_real_knots_completes_fast() {
    let content = moderate_degree_surface_content(40);
    let mut decoder = EntityDecoder::new(&content);
    let surface_id = 40 + 14 + 1;
    let bspline = decoder.decode_by_id(surface_id as u32).unwrap();

    let start = Instant::now();
    let result = process_bspline_face(&bspline, &mut decoder, None, TessellationQuality::Medium);
    let elapsed = start.elapsed();

    assert!(result.is_ok(), "a well-formed degree-40 surface must tessellate: {result:?}");
    assert!(
        elapsed < Duration::from_secs(2),
        "memoized basis evaluation must stay fast even at degree=40, took {elapsed:?}"
    );
}

/// Baseline: a legitimate (degree=2, 9 control points) surface still
/// tessellates, proving the #4901 bounds don't touch real output.
#[test]
fn legitimate_bspline_surface_still_tessellates() {
    let content = small_surface_content(2, 2);
    let mut decoder = EntityDecoder::new(&content);
    let bspline = decoder.decode_by_id(10).unwrap();
    let (positions, indices) =
        process_bspline_face(&bspline, &mut decoder, None, TessellationQuality::Medium)
            .expect("degree-2 3x3 control grid must tessellate");
    assert!(!positions.is_empty() && !indices.is_empty());
}

/// #4901: a file-supplied `UDegree` far past any practical NURBS must be
/// rejected LOUDLY and FAST. This construction (a huge degree against a tiny
/// knot vector) happens to bail via `tessellate_bspline_surface`'s pre-existing
/// `min_u_knots` guard even pre-fix — the exponential-recursion hang needs a
/// degree paired with a MATCHING (also file-suppliable) knot vector length,
/// which the old naive, non-memoized `bspline_basis` could not safely
/// evaluate at any degree past a couple dozen. The point of this test is that
/// the new `MAX_BSPLINE_DEGREE` guard now rejects the degree itself, before
/// either guard is reached, so no future change to the knot-length checks can
/// reopen the exponential path.
#[test]
fn pathological_degree_fails_fast_not_hangs() {
    let content = small_surface_content(999_999, 2);
    let mut decoder = EntityDecoder::new(&content);
    let bspline = decoder.decode_by_id(10).unwrap();

    let start = Instant::now();
    let result = process_bspline_face(&bspline, &mut decoder, None, TessellationQuality::Medium);
    let elapsed = start.elapsed();

    let err = result.expect_err("a degree past MAX_BSPLINE_DEGREE must be a typed failure");
    assert!(
        err.to_string().contains("degree") && err.to_string().contains("4901"),
        "error should name the cause and cite #4901: {err}"
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "pathological degree must fail within the deterministic bound, took {elapsed:?}"
    );
}

/// #4901: an attacker-sized `ControlPointsList` (well within a legitimate
/// degree) is a second, independent way to blow up the per-sample weighted
/// sum (`O(n_u * n_v)`), and must also be rejected loudly and fast.
#[test]
fn pathological_control_point_grid_fails_fast_not_hangs() {
    // One row of 5000 control points (> MAX_BSPLINE_SURFACE_CONTROL_POINTS),
    // degree 2 (legitimate), 5000 + 2 + 1 = 5003 knots via a single
    // multiplicity-5003 entry.
    let n = 5000usize;
    let mut content = String::new();
    for i in 1..=n {
        content.push_str(&format!("#{i}=IFCCARTESIANPOINT(({}.,0.,0.));\n", i));
    }
    let row: Vec<String> = (1..=n).map(|i| format!("#{i}")).collect();
    let surface_id = n + 1;
    content.push_str(&format!(
        "#{surface_id}=IFCBSPLINESURFACEWITHKNOTS(2,0,(({row})),.UNSPECIFIED.,.F.,.F.,.F.,({knot_count}),(1),(0.),(0.,1.),.UNSPECIFIED.);\n",
        row = row.join(","),
        knot_count = n + 3,
    ));

    let mut decoder = EntityDecoder::new(&content);
    let bspline = decoder.decode_by_id(surface_id as u32).unwrap();

    let start = Instant::now();
    let result = process_bspline_face(&bspline, &mut decoder, None, TessellationQuality::Medium);
    let elapsed = start.elapsed();

    let err = result.expect_err("an oversized control-point grid must be a typed failure");
    assert!(
        err.to_string().contains("control point") && err.to_string().contains("4901"),
        "error should name the cause and cite #4901: {err}"
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "oversized control-point grid must fail within the deterministic bound, took {elapsed:?}"
    );
}
