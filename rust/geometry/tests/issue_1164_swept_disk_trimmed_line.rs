// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #1164 — an `IfcReinforcingBar` whose body is an
//! `IfcSweptDiskSolid` swept along an `IfcTrimmedCurve` over an `IfcLine` failed
//! to load (empty mesh). The curve sampler had no `IfcLine` arm, so resolving the
//! trimmed-line directrix returned "Unsupported curve type: IfcLine" and the
//! swept-disk mesh collapsed to nothing.
//!
//! The fixture is a neutral, self-contained reproduction of the issue file's
//! geometry chain: a 2750 mm-long, 29 mm-diameter bar along the X axis, wrapped
//! through a RepresentationMap + MappedItem exactly as the reported model.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::{GeometryRouter, ProfileProcessor, TessellationQuality};

const FIXTURE: &str = "tests/fixtures/swept_disk_trimmed_line.ifc";

fn read_fixture() -> String {
    std::fs::read_to_string(FIXTURE)
        .unwrap_or_else(|e| panic!("failed to read fixture {FIXTURE}: {e}"))
}

fn bounds(mesh: &ifc_lite_geometry::Mesh) -> ([f32; 3], [f32; 3]) {
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

#[test]
fn trimmed_line_directrix_samples_to_the_full_segment() {
    // Sample the directrix in isolation: the IfcTrimmedCurve (param 0..2750) over
    // the IfcLine must resolve to the segment endpoints, not error out.
    let content = read_fixture();
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);

    let trimmed = decoder
        .decode_by_id(42)
        .expect("decode #42 IfcTrimmedCurve");
    assert_eq!(trimmed.ifc_type, IfcType::IfcTrimmedCurve);

    let pp = ProfileProcessor::new(ifc_lite_core::IfcSchema::new());
    let pts = pp
        .get_curve_points(&trimmed, &mut decoder, TessellationQuality::Medium)
        .expect("sample trimmed-line directrix");

    assert_eq!(pts.len(), 2, "trimmed line should yield two endpoints");
    // Authored extent: (0,0,0) .. (2750,0,0) in the file's millimetres.
    assert!((pts[0] - nalgebra::Point3::new(0.0, 0.0, 0.0)).norm() < 1e-6);
    assert!((pts[1] - nalgebra::Point3::new(2750.0, 0.0, 0.0)).norm() < 1e-6);
}

#[test]
fn reinforcing_bar_swept_disk_produces_a_tube() {
    let content = read_fixture();
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let bar = decoder
        .decode_by_id(50)
        .expect("decode #50 IfcReinforcingBar");
    assert_eq!(bar.ifc_type, IfcType::IfcReinforcingBar);

    let mesh = router
        .process_element(&bar, &mut decoder)
        .expect("process reinforcing bar");

    // Pre-fix: empty mesh (the directrix sampler errored on IfcLine).
    assert!(
        !mesh.indices.is_empty(),
        "swept-disk bar produced no geometry — the IfcLine directrix sampler \
         regressed (issue #1164)",
    );

    // A swept circular profile (24 segments) along a 2-point directrix yields a
    // tube of side quads plus two end caps: 24*2 + 24 + 24 = 96 triangles.
    let tri_count = mesh.indices.len() / 3;
    assert!(
        tri_count >= 90,
        "expected a full tube (~96 triangles), got {tri_count}",
    );

    // Units are millimetres → metres (scale 1e-3). The bar is 2750 mm = 2.75 m
    // along its long axis and 29 mm = 0.029 m in diameter on the perpendicular
    // axes. The pre-fix bug rendered nothing; a naive "raw IfcLine, unit
    // magnitude" mis-sample would render a 1 mm stub instead.
    let (min, max) = bounds(&mesh);
    let span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    let long_axis = span[0].max(span[1]).max(span[2]);
    assert!(
        (long_axis - 2.75).abs() < 0.05,
        "expected ≈2.75 m long bar, got {long_axis} m (span {span:?})",
    );
    let cross = {
        let mut sorted = span;
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        sorted[0].max(sorted[1]) // largest of the two short axes
    };
    assert!(
        (cross - 0.029).abs() < 0.005,
        "expected ≈0.029 m diameter, got {cross} m (span {span:?})",
    );
}

#[test]
fn swept_disk_ships_unit_normals() {
    // The swept-disk processor must ship per-vertex normals, computed in its
    // directrix-local (small-coordinate) frame. If it ships empty normals,
    // downstream consumers recompute them from world-space f32 positions — and
    // at a georef-scale placement (rebar at national-grid coordinates ~6 km from
    // origin) the edge differences cancel catastrophically into garbage normals,
    // rendering the tube as a field of specular sparkles (#1164 follow-up).
    let content = read_fixture();
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let bar = decoder
        .decode_by_id(50)
        .expect("decode #50 IfcReinforcingBar");
    let mesh = router
        .process_element(&bar, &mut decoder)
        .expect("process reinforcing bar");

    assert_eq!(
        mesh.normals.len(),
        mesh.positions.len(),
        "swept-disk mesh must ship one normal per position; got {} normal floats \
         for {} position floats",
        mesh.normals.len(),
        mesh.positions.len(),
    );
    let mut bad = 0usize;
    for n in mesh.normals.chunks_exact(3) {
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if !len.is_finite() || (len - 1.0).abs() > 1e-3 {
            bad += 1;
        }
    }
    assert_eq!(bad, 0, "{bad} non-unit / NaN normals on the swept-disk tube");
}
