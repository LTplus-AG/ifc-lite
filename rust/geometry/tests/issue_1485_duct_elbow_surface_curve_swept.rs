// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #1485 — round HVAC duct elbows exported by Revit as
//! `IfcSurfaceCurveSweptAreaSolid` (a circular `SweptArea` swept along a trimmed
//! circular-arc `Directrix`) rendered as **nothing**: the geometry router had no
//! processor registered for the type, so every elbow body was silently dropped.
//!
//! The fixture is a neutral, self-contained reproduction of the reported
//! geometry chain (no data from the reporter's model): a 90-degree round elbow
//! with a 50 mm bore radius swept along a 150 mm bend-radius arc that lies in the
//! XY plane. Because the bend is planar, a correctly swept tube is exactly the
//! bore diameter (100 mm) thick in Z, and its surface stays exactly one bore
//! radius from the arc centre-line — both are checked below. A second fitting
//! repeats the elbow as an `IfcFixedReferenceSweptAreaSolid` (same processor).

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::{GeometryRouter, Mesh, ProfileProcessor, TessellationQuality};

const FIXTURE: &str = "tests/fixtures/issue_1485_duct_elbow_surface_curve_swept.ifc";

// Fixture parameters, in metres (the fixture authors them in millimetres).
const BORE_R: f32 = 0.050; // SweptArea circle radius
const BEND_R: f32 = 0.150; // directrix arc radius
const CENTER: [f32; 3] = [0.0, 0.150, 0.0]; // directrix arc centre, in the z=0 plane

fn read_fixture() -> String {
    std::fs::read_to_string(FIXTURE).unwrap_or_else(|e| panic!("read fixture {FIXTURE}: {e}"))
}

fn bounds(mesh: &Mesh) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for c in mesh.positions.chunks_exact(3) {
        for a in 0..3 {
            min[a] = min[a].min(c[a]);
            max[a] = max[a].max(c[a]);
        }
    }
    (min, max)
}

/// Distance from a point to the arc centre-line circle (radius `BEND_R`,
/// centred at `CENTER`, lying in the z = CENTER.z plane).
fn dist_to_centerline(p: &[f32]) -> f32 {
    let dx = p[0] - CENTER[0];
    let dy = p[1] - CENTER[1];
    let dz = p[2] - CENTER[2];
    let radial = (dx * dx + dy * dy).sqrt(); // distance from the circle's axis
    ((radial - BEND_R).powi(2) + dz * dz).sqrt()
}

/// Nearest point on the centre-line circle to `p`. Returns `None` on the axis
/// where the nearest point is undefined.
fn nearest_centerline(p: &[f32]) -> Option<[f32; 3]> {
    let dx = p[0] - CENTER[0];
    let dy = p[1] - CENTER[1];
    let radial = (dx * dx + dy * dy).sqrt();
    if radial < 1e-5 {
        return None;
    }
    Some([
        CENTER[0] + dx / radial * BEND_R,
        CENTER[1] + dy / radial * BEND_R,
        CENTER[2],
    ])
}

fn process_fitting(id: u32) -> Mesh {
    let content = read_fixture();
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let fitting = decoder
        .decode_by_id(id)
        .unwrap_or_else(|e| panic!("decode fitting #{id}: {e:?}"));
    assert_eq!(fitting.ifc_type, IfcType::IfcDuctFitting);
    router
        .process_element(&fitting, &mut decoder)
        .unwrap_or_else(|e| panic!("process fitting #{id}: {e:?}"))
}

/// The core regression: the swept elbow must produce a real, correctly shaped
/// tube (pre-fix it produced an empty mesh).
fn assert_elbow_is_a_tube(id: u32, label: &str) {
    let mesh = process_fitting(id);

    let tris = mesh.indices.len() / 3;
    assert!(
        tris > 200,
        "{label} #{id}: only {tris} triangles — the swept elbow was dropped or degenerate \
         (issue #1485 regression)"
    );

    let (min, max) = bounds(&mesh);
    let span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];

    // The bend is planar in XY, so the tube is exactly the bore diameter thick in
    // Z. This pins the bore radius and proves the section did not twist out of
    // plane.
    let diameter = 2.0 * BORE_R;
    assert!(
        (span[2] - diameter).abs() < 0.003,
        "{label} #{id}: Z span {:.4} m, expected the bore diameter {diameter:.3} m",
        span[2]
    );

    // The in-plane extent must reflect the 150 mm bend arc plus the bore, not a
    // collapsed section: roughly (BEND_R + BORE_R) .. so ~0.2 m each.
    for axis in [0usize, 1] {
        assert!(
            span[axis] > 0.18 && span[axis] < 0.22,
            "{label} #{id}: axis {axis} span {:.4} m, expected ~0.20 m (arc + bore)",
            span[axis]
        );
    }

    // Adversarial shape check: every vertex must sit within one bore radius of the
    // arc centre-line (a genuine tube), and the wall must actually reach the bore
    // radius. A wrong radius, an off-axis sweep, or a flattened/ballooned tube all
    // break this.
    let mut worst_outside = 0.0f32;
    let mut reaches = 0.0f32;
    for p in mesh.positions.chunks_exact(3) {
        let d = dist_to_centerline(p);
        worst_outside = worst_outside.max(d - BORE_R); // > 0 means outside the tube
        reaches = reaches.max(d);
    }
    assert!(
        worst_outside < 0.003,
        "{label} #{id}: a vertex sits {:.4} m outside the {BORE_R:.3} m bore tube \
         — the sweep radius/axis is wrong",
        worst_outside
    );
    assert!(
        (reaches - BORE_R).abs() < 0.003,
        "{label} #{id}: tube wall reaches only {reaches:.4} m from the centre-line, \
         expected the bore radius {BORE_R:.3} m",
    );

    // Normals must face outward (radially away from the arc centre-line). A
    // flipped sweep winding renders the tube lit inside-out. Averaged smooth
    // normals at the cap seams tilt, so require a strong majority rather than
    // every vertex.
    assert_eq!(mesh.normals.len(), mesh.positions.len(), "missing normals");
    let (mut wall, mut outward) = (0u32, 0u32);
    for i in 0..mesh.positions.len() / 3 {
        let p = &mesh.positions[3 * i..3 * i + 3];
        if (dist_to_centerline(p) - BORE_R).abs() > 0.006 {
            continue; // cap interior, not a wall vertex
        }
        let Some(cl) = nearest_centerline(p) else {
            continue;
        };
        let out = [p[0] - cl[0], p[1] - cl[1], p[2] - cl[2]];
        let out_len = (out[0] * out[0] + out[1] * out[1] + out[2] * out[2]).sqrt();
        if out_len < 1e-6 {
            continue;
        }
        let n = &mesh.normals[3 * i..3 * i + 3];
        let dot = (n[0] * out[0] + n[1] * out[1] + n[2] * out[2]) / out_len;
        wall += 1;
        if dot > 0.3 {
            outward += 1;
        }
    }
    assert!(
        wall > 50,
        "{label} #{id}: only {wall} wall vertices sampled"
    );
    assert!(
        outward * 100 > wall * 90,
        "{label} #{id}: normals not outward ({outward}/{wall}) — swept tube winding is inverted"
    );
}

#[test]
fn surface_curve_swept_elbow_renders_as_a_tube() {
    assert_elbow_is_a_tube(58, "IfcSurfaceCurveSweptAreaSolid");
}

#[test]
fn fixed_reference_swept_elbow_renders_as_a_tube() {
    assert_elbow_is_a_tube(74, "IfcFixedReferenceSweptAreaSolid");
}

/// The directrix on its own must sample a planar 90-degree arc of the bend
/// radius — the sampling foundation the sweep relies on.
#[test]
fn directrix_is_a_planar_quarter_arc() {
    let content = read_fixture();
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let directrix = decoder.decode_by_id(48).unwrap();
    assert_eq!(directrix.ifc_type, IfcType::IfcTrimmedCurve);

    let pp = ProfileProcessor::new(ifc_lite_core::IfcSchema::new());
    let pts = pp
        .get_curve_points(&directrix, &mut decoder, TessellationQuality::Medium)
        .expect("sample directrix");
    assert!(
        pts.len() >= 5,
        "expected a sampled arc, got {} pts",
        pts.len()
    );

    // Planar (authored in the z = 0 plane, millimetres).
    let worst_z = pts.iter().fold(0.0f64, |a, p| a.max(p.z.abs()));
    assert!(
        worst_z < 1.0,
        "directrix left the z=0 plane: max |z| = {worst_z:.4} mm"
    );

    // Every sample is one bend radius (150 mm) from the arc centre (0,150).
    for p in &pts {
        let r = ((p.x - 0.0).powi(2) + (p.y - 150.0).powi(2)).sqrt();
        assert!(
            (r - 150.0).abs() < 1.0,
            "directrix point {p:?} is {r:.3} mm from centre, expected 150 mm"
        );
    }

    // Endpoints span a quarter turn: from (0,0) to (150,150).
    let start = pts.first().unwrap();
    let end = pts.last().unwrap();
    assert!(
        start.x.abs() < 1.0 && start.y.abs() < 1.0,
        "arc start not at (0,0): {start:?}"
    );
    assert!(
        (end.x - 150.0).abs() < 1.0 && (end.y - 150.0).abs() < 1.0,
        "arc end not at (150,150): {end:?}"
    );
}
