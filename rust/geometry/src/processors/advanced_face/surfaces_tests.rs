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
    let result = process_bspline_face(
        &bspline,
        &mut decoder,
        None,
        TessellationQuality::Medium,
        (0.0, 0.0, 0.0),
    );
    let elapsed = start.elapsed();

    assert!(result.is_ok(), "a well-formed degree-40 surface must tessellate: {result:?}");
    assert!(
        elapsed < Duration::from_secs(2),
        "memoized basis evaluation must stay fast even at degree=40, took {elapsed:?}"
    );
}

/// #4206 regression: a hole ring with a non-finite vertex must make the
/// WHOLE planar face fail, never silently fall back to the no-hole fan
/// (which would fill in the authored opening). `1.0E400` is a legal STEP
/// `REAL` literal — `lexical_core` parses an out-of-range exponent to
/// `f64::INFINITY` rather than erroring the entity — so a corrupt or
/// hostile file can genuinely produce this without any test-only hook.
///
/// Entered through the `process_planar_face_rebased` seam (formerly
/// `process_planar_face`, merged with its RTC twin by #5698), not the private
/// `triangulate_planar_indices` helper it delegates to, so that reverting
/// the fix is observed as a failing ASSERTION (the pre-fix code returns `Ok`
/// with the hole silently filled in) rather than a compile error:
/// `triangulate_planar_indices` did not exist before this change, so a unit test that named it directly could never survive a
/// production revert to prove the regression.
#[test]
fn failed_hole_triangulation_never_falls_back_to_a_filled_outer_fan() {
    let content = "\
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((10.,0.,0.));\
#3=IFCCARTESIANPOINT((10.,10.,0.));#4=IFCCARTESIANPOINT((0.,10.,0.));\
#5=IFCPOLYLOOP((#1,#2,#3,#4));#6=IFCFACEOUTERBOUND(#5,.T.);\
#7=IFCCARTESIANPOINT((4.,4.,0.));#8=IFCCARTESIANPOINT((1.0E400,4.,0.));\
#9=IFCCARTESIANPOINT((6.,6.,0.));#10=IFCPOLYLOOP((#7,#8,#9));\
#11=IFCFACEBOUND(#10,.T.);\
#12=IFCAXIS2PLACEMENT3D(#1,$,$);#13=IFCPLANE(#12);\
#14=IFCFACESURFACE((#6,#11),#13,.T.);";
    let mut decoder = EntityDecoder::new(content);
    let face = decoder.decode_by_id(14).unwrap();

    let error =
        process_planar_face_rebased(&face, &mut decoder, TessellationQuality::Medium, None)
            .unwrap_err();
    assert!(
        error.to_string().contains("triangulation with holes failed"),
        "a failed holed face must be rejected instead of filling the opening: {error}"
    );
}

/// Baseline: a legitimate (degree=2, 9 control points) surface still
/// tessellates, proving the #4901 bounds don't touch real output.
#[test]
fn legitimate_bspline_surface_still_tessellates() {
    let content = small_surface_content(2, 2);
    let mut decoder = EntityDecoder::new(&content);
    let bspline = decoder.decode_by_id(10).unwrap();
    let (positions, indices) = process_bspline_face(
        &bspline,
        &mut decoder,
        None,
        TessellationQuality::Medium,
        (0.0, 0.0, 0.0),
    )
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
    let result = process_bspline_face(
        &bspline,
        &mut decoder,
        None,
        TessellationQuality::Medium,
        (0.0, 0.0, 0.0),
    );
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
/// sum (`O(samples * n_u * n_v)`), and must also be rejected loudly and fast.
///
/// A flat control-point-COUNT cap was tried first and reverted: the in-tree
/// `tests/models/issues/472_2222.ifc` fixture legitimately carries a 207x180
/// grid, so the bound has to be the actual cost driver (samples * n_u * n_v,
/// [`MAX_BSPLINE_SURFACE_SAMPLE_WORK`]), not raw point count. A 250x250 grid
/// (62,500 points, still far short of a real 37,260-point fixture on its
/// own) combined with `Highest` quality's maxed-out 96-segment-per-axis
/// tessellation pushes the WORK estimate (9,409 samples * 62,500 points ≈
/// 588M) just past the 500M bound.
#[test]
fn pathological_sample_work_fails_fast_not_hangs() {
    let (n_u, n_v) = (250usize, 250usize);
    let mut content = String::new();
    let mut id = 0usize;
    let mut rows: Vec<String> = Vec::with_capacity(n_u);
    for _ in 0..n_u {
        let mut row: Vec<String> = Vec::with_capacity(n_v);
        for _ in 0..n_v {
            id += 1;
            content.push_str(&format!("#{id}=IFCCARTESIANPOINT(({}.,0.,0.));\n", id));
            row.push(format!("#{id}"));
        }
        rows.push(format!("({})", row.join(",")));
    }
    let surface_id = id + 1;
    // Degree 2 per axis (legitimate): n + degree + 1 knots via one
    // multiplicity entry covering the whole span.
    content.push_str(&format!(
        "#{surface_id}=IFCBSPLINESURFACEWITHKNOTS(2,2,({rows}),.UNSPECIFIED.,.F.,.F.,.F.,({u_knots}),({v_knots}),(0.),(0.),.UNSPECIFIED.);\n",
        rows = rows.join(","),
        u_knots = n_u + 3,
        v_knots = n_v + 3,
    ));

    let mut decoder = EntityDecoder::new(&content);
    let bspline = decoder.decode_by_id(surface_id as u32).unwrap();

    let start = Instant::now();
    let result = process_bspline_face(
        &bspline,
        &mut decoder,
        None,
        TessellationQuality::Highest,
        (0.0, 0.0, 0.0),
    );
    let elapsed = start.elapsed();

    let err = result.expect_err("an oversized sample-work estimate must be a typed failure");
    assert!(
        err.to_string().contains("sampling work") && err.to_string().contains("4901"),
        "error should name the cause and cite #4901: {err}"
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "oversized sample work must fail within the deterministic bound, took {elapsed:?}"
    );
}

/// #4901, caught in review: `weighted_sum_work` (`n_u * n_v`) alone is zero
/// (or tiny) for a grid of many near-empty rows — a ragged
/// `ControlPointsList` with 15,000 single-point rows has `n_v = 1`, so the
/// OLD estimate (`samples * n_u * n_v`) stayed small regardless of how big
/// `n_u` got, even though `bspline_basis_table`'s U-axis build is still
/// `O(degree * n_u)` PER SAMPLE POINT, independent of `n_v`. The bound must
/// include that table-build term or a many-row, thin-column grid bypasses it
/// entirely (unlike the point-count cap, there is no OTHER cap this falls
/// back to).
#[test]
fn pathological_ragged_row_count_fails_fast_not_hangs() {
    let n_u = 6_000usize;
    let degree = 64usize; // within MAX_BSPLINE_DEGREE; isolates the table-build term
    let mut content = String::new();
    for i in 1..=n_u {
        content.push_str(&format!("#{i}=IFCCARTESIANPOINT(({}.,0.,0.));\n", i));
    }
    let rows: Vec<String> = (1..=n_u).map(|i| format!("(#{i})")).collect();
    let surface_id = n_u + 1;
    content.push_str(&format!(
        "#{surface_id}=IFCBSPLINESURFACEWITHKNOTS({degree},0,({rows}),.UNSPECIFIED.,.F.,.F.,.F.,({u_knots}),(2),(0.),(0.),.UNSPECIFIED.);\n",
        rows = rows.join(","),
        u_knots = n_u + degree + 1,
    ));

    let mut decoder = EntityDecoder::new(&content);
    let bspline = decoder.decode_by_id(surface_id as u32).unwrap();

    let start = Instant::now();
    let result = process_bspline_face(
        &bspline,
        &mut decoder,
        None,
        TessellationQuality::Highest,
        (0.0, 0.0, 0.0),
    );
    let elapsed = start.elapsed();

    let err = result.expect_err("a many-row, thin-column grid must be a typed failure too");
    assert!(
        err.to_string().contains("sampling work") && err.to_string().contains("4901"),
        "error should name the cause and cite #4901: {err}"
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "ragged-row grid must fail within the deterministic bound, took {elapsed:?}"
    );
}
