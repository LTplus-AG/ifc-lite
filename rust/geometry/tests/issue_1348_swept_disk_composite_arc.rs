// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #1348 — `IfcReinforcingBar` bodies that are an
//! `IfcSweptDiskSolid` swept along an `IfcCompositeCurve` containing arc bends
//! (an `IfcTrimmedCurve` over an `IfcCircle`) rendered mangled: the L-bar grew
//! a spurious hook and the U-bar twisted into a crumpled mess.
//!
//! Root cause: a trimmed circle directrix segment was sampled through the 2D
//! conic path and lifted with `z = 0`, dropping the arc's out-of-plane
//! component. Tekla rebar bends live in the XZ plane (the circle's
//! `IfcAxis2Placement3D` has a non-Z axis), so the flattened arc landed in the
//! wrong plane and broke the directrix.
//!
//! The fixtures are neutral, self-contained reproductions of the reported
//! geometry chains: a single `IfcSweptDiskSolid` per bar, swept along a
//! composite curve whose whole directrix lies in the `y ≈ 0` plane. A correctly
//! sampled bar therefore stays thin in Y (just the tube diameter); the pre-fix
//! flattening pushed the arc out to ±(arc radius) in Y.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::{GeometryRouter, Mesh, ProfileProcessor, TessellationQuality};

fn read_fixture(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("failed to read fixture {path}: {e}"))
}

fn bounds(mesh: &Mesh) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for chunk in mesh.positions.chunks_exact(3) {
        for axis in 0..3 {
            min[axis] = min[axis].min(chunk[axis]);
            max[axis] = max[axis].max(chunk[axis]);
        }
    }
    (min, max)
}

/// Sample the composite-curve directrix in isolation and confirm every point
/// stays in the `y ≈ 0` plane the bar was authored in. Pre-fix, the trimmed
/// circle arc was computed in 2D and lifted to `z = 0`, pushing its points out
/// to the arc radius in Y.
fn assert_directrix_is_planar(
    fixture: &str,
    composite_id: u32,
    max_abs_y_mm: f64,
    min_abs_z_mm: f64,
) {
    let content = read_fixture(fixture);
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);

    let curve = decoder
        .decode_by_id(composite_id)
        .unwrap_or_else(|e| panic!("decode composite curve #{composite_id}: {e:?}"));
    assert_eq!(curve.ifc_type, IfcType::IfcCompositeCurve);

    let pp = ProfileProcessor::new(ifc_lite_core::IfcSchema::new());
    let pts = pp
        .get_curve_points(&curve, &mut decoder, TessellationQuality::High)
        .expect("sample composite-curve directrix");

    assert!(pts.len() > 4, "expected a sampled arc, got {} points", pts.len());

    let worst_y = pts.iter().fold(0.0_f64, |acc, p| acc.max(p.y.abs()));
    assert!(
        worst_y < max_abs_y_mm,
        "directrix left the y≈0 plane: max |y| = {worst_y:.3} mm (limit {max_abs_y_mm} mm). \
         The trimmed circle arc was flattened to z=0 instead of sampled in its 3D placement \
         (issue #1348)",
    );

    // And the arc must actually descend in Z (the bend lives in the XZ plane).
    let worst_z = pts.iter().fold(0.0_f64, |acc, p| acc.max(p.z.abs()));
    assert!(
        worst_z > min_abs_z_mm,
        "directrix never left z=0 (max |z| = {worst_z:.3} mm); the arc was not sampled in 3D",
    );
}

#[test]
fn lbar_directrix_stays_planar() {
    // L-bar arc radius is 89.5 mm; the pre-fix flatten pushed Y out to ~89.5.
    // The bend descends ~89.5 mm, then the down-leg another 160 mm.
    assert_directrix_is_planar(
        "tests/fixtures/swept_disk_composite_arc_lbar.ifc",
        59,
        1.0,
        50.0,
    );
}

#[test]
fn ubar_directrix_stays_planar() {
    // U-bar arc radius is 101.5 mm; the pre-fix flatten pushed Y out to ~101.5.
    assert_directrix_is_planar(
        "tests/fixtures/swept_disk_composite_arc_ubar.ifc",
        71,
        1.0,
        50.0,
    );
}

#[test]
fn crankbar_directrix_stays_planar() {
    // Crank bar (issue #1350): two SMALL arcs (~4.7°) joining an offset run. The
    // pre-fix flatten only pushed Y out to ~10.7 mm here — not visually obvious,
    // but the resulting self-intersecting tube degenerated badly enough that the
    // viewer dropped it entirely ("shape not rendered when viewed alone"). The
    // crank only steps down ~47 mm, so the in-3D z check uses a smaller floor.
    assert_directrix_is_planar(
        "tests/fixtures/swept_disk_composite_arc_crankbar.ifc",
        70,
        1.0,
        10.0,
    );
}

/// End-to-end: process the whole `IfcReinforcingBar` and confirm the swept tube
/// is thin in Y (only the tube diameter wide). A flattened arc balloons the Y
/// extent out to roughly twice the arc radius.
fn assert_bar_is_thin_in_y(fixture: &str, bar_id: u32, diameter_m: f32) {
    let content = read_fixture(fixture);
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let bar = decoder
        .decode_by_id(bar_id)
        .unwrap_or_else(|e| panic!("decode reinforcing bar #{bar_id}: {e:?}"));
    assert_eq!(bar.ifc_type, IfcType::IfcReinforcingBar);

    let mesh = router
        .process_element(&bar, &mut decoder)
        .expect("process reinforcing bar");
    assert!(!mesh.indices.is_empty(), "swept-disk bar produced no geometry");

    let (min, max) = bounds(&mesh);
    let y_span = max[1] - min[1];
    // The whole directrix is in the y≈0 plane, so the swept tube's Y extent is
    // just its diameter. Allow a small margin for tessellation. Pre-fix the
    // flattened arc made this ~0.2 m (L) / ~0.23 m (U).
    assert!(
        y_span < diameter_m * 2.0,
        "bar Y-span = {y_span:.4} m, expected ≈{diameter_m} m (tube diameter). \
         The arc was flattened out of the y≈0 plane (issue #1348)",
    );
}

#[test]
fn lbar_swept_tube_is_thin_in_y() {
    // 19 mm nominal diameter → tube radius 9.5 mm → 0.019 m diameter.
    assert_bar_is_thin_in_y(
        "tests/fixtures/swept_disk_composite_arc_lbar.ifc",
        78,
        0.019,
    );
}

#[test]
fn ubar_swept_tube_is_thin_in_y() {
    // 29 mm tube radius 14.5 mm → 0.029 m diameter.
    assert_bar_is_thin_in_y(
        "tests/fixtures/swept_disk_composite_arc_ubar.ifc",
        125,
        0.029,
    );
}

#[test]
fn crankbar_renders_and_is_thin_in_y() {
    // Issue #1350: the crank bar rendered nothing when viewed as a single
    // element. With the directrix sampled in 3D it produces a clean swept tube
    // that stays in its y≈0 plane (37 mm tube diameter).
    assert_bar_is_thin_in_y(
        "tests/fixtures/swept_disk_composite_arc_crankbar.ifc",
        79,
        0.037,
    );
}
