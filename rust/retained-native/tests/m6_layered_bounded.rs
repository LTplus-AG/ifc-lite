// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: a layered bounded product publishes open bands whose union is the
//! closed skin. The bounded oracle checks that union only (closure, section
//! volume, bounds); the per-band split is the M4 layer report's
//! (`examples/compare/checks/layers.rs`). These tests drive the comparison's own
//! check, so a change to how it measures the parts is observed here.
#[allow(dead_code)]
#[path = "../examples/compare/metrics.rs"]
mod metrics;
#[allow(dead_code)]
#[path = "../examples/compare/checks/mod.rs"]
mod checks;

use checks::{bounded::check_parts, OracleResult};
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::program::transactions::ShapeLayer;
use ifc_lite_retained_native::oracle::bounded;
use ifc_lite_retained_native::{run_model_native, ModelOptions, ProductOutcome, ShapePart};

const SOURCE: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-f-halfspaces.ifc");
const M6: &str = include_str!("../../../tests/fixtures/cli-retained/tolerances.d/m6.json");

/// M6 a's 4 m box with a full-footprint bounded halfspace removing everything
/// above z = 3, so the kept solid is the box [0,4]x[0,4]x[0,3] (48 m3).
fn capped_box() -> String {
    let text = SOURCE.replace("#369=IFCSHAPEREPRESENTATION(#4,'Body','CSG',(#333));", "#369=IFCSHAPEREPRESENTATION(#4,'Body','CSG',(#9204));")
        .replace("ENDSEC;\nEND-ISO-10303-21;", "#9200=IFCPOLYGONALBOUNDEDHALFSPACE(#9201,.F.,#2,#34);\n#9201=IFCPLANE(#9202);\n\
#9202=IFCAXIS2PLACEMENT3D(#9203,#298,#299);\n#9203=IFCCARTESIANPOINT((0.,0.,3.));\n#9204=IFCBOOLEANRESULT(.DIFFERENCE.,#12,#9200);\nENDSEC;\nEND-ISO-10303-21;");
    assert!(text.contains("(#9204));") && text.contains("#9204=IFCBOOLEAN"), "fixture rewritten");
    text
}

/// One material band y0..y1 of the kept box, without its face on the band
/// interface y = 2: open on its own, closed only together with its neighbour.
fn band(index: u16, y0: f64, y1: f64) -> ShapePart {
    let positions: Vec<f64> = (0..8).flat_map(|i| [if i & 4 != 0 { 4. } else { 0. }, if i & 2 != 0 { y1 } else { y0 }, if i & 1 != 0 { 3. } else { 0. }]).collect();
    let point = |i: u32| { let i = i as usize * 3; [positions[i], positions[i + 1], positions[i + 2]] };
    let centre = [2., (y0 + y1) / 2., 1.5];
    let interface_y = if y0 == 2. { [0, 4, 5, 1] } else { [2, 6, 7, 3] };
    let mut indices = Vec::new();
    for quad in [[0, 1, 3, 2], [4, 5, 7, 6], [0, 4, 6, 2], [1, 5, 7, 3], [0, 4, 5, 1], [2, 6, 7, 3]] {
        if quad == interface_y { continue; }
        let [a, b, c, _] = quad.map(point);
        let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        let outward = (0..3).map(|k| n[k] * ((a[k] + c[k]) / 2. - centre[k])).sum::<f64>() > 0.;
        let [q0, q1, q2, q3] = if outward { quad } else { [quad[0], quad[3], quad[2], quad[1]] };
        indices.extend([q0, q1, q2, q0, q2, q3]);
    }
    ShapePart { layer: Some(ShapeLayer { index, material_id: 5000 + u32::from(index) }), capped_volume_m3: None, positions, indices,
        world_from_object: [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.], curved: false, halfspace_clipped: false,
        revision_local_faces: Vec::new(), normals: None, appearance: None, faces: None, instance_key: None }
}

fn rows(parts: &[ShapePart]) -> Vec<OracleResult> {
    let text = capped_box();
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(), None);
    let e = bounded::expected(text.as_bytes(), &sources, 1000).expect("bounded source expectation");
    assert!((e.host_volume - 64.).abs() < 1e-9 && (e.section_volume.expect("section integral") - 48.).abs() < 1e-9, "hand integrals: host 64, kept 48");
    let t: serde_json::Value = serde_json::from_str(M6).unwrap();
    check_parts(1000, parts, Some(&e), &t, None, text.as_bytes())
}
fn family<'a>(rows: &'a [OracleResult], name: &str) -> &'a OracleResult {
    rows.iter().find(|r| r.family == name).unwrap_or_else(|| panic!("{name} row missing"))
}
fn table(rows: &[OracleResult]) -> Vec<(&str, f64, f64)> { rows.iter().map(|r| (r.family, r.value, r.limit)).collect() }

#[test]
fn layered_bounded_bands_pass_as_one_solid() {
    let parts = [band(0, 0., 2.), band(1, 2., 4.)];
    // Each band alone is open: per-part counting would report the interface rim.
    for part in &parts {
        let mut alone = metrics::Metrics::default();
        let points: Vec<_> = part.positions.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
        alone.add_mesh(&points, &part.indices).unwrap();
        assert_eq!(alone.defects, 4, "a band is open along its four interface edges");
    }
    let rows = rows(&parts);
    for name in ["bounded_closure", "bounded_section_volume", "bounded_volume_bounds", "bounded_outside_material"] {
        let row = family(&rows, name);
        assert!(row.gated && row.pass, "{name} must pass for the assembled bands: {:?}", table(&rows));
    }
    assert_eq!(family(&rows, "bounded_closure").value, 0.);
}

// Review probe for #8475: the assembly ledger must not hide an open band.
#[test]
fn assembly_cannot_hide_a_band_missing_a_triangle() {
    let mut torn = band(0, 0., 2.);
    torn.indices.drain(0..3);
    let rows = rows(&[torn, band(1, 2., 4.)]);
    let closure = family(&rows, "bounded_closure");
    assert!(!closure.pass && closure.value > 0., "a removed triangle must fail closure: {:?}", table(&rows));
}

#[test]
fn assembly_cannot_hide_a_dropped_band() {
    let rows = rows(&[band(0, 0., 2.)]);
    assert!(!family(&rows, "bounded_closure").pass, "a dropped band leaves the interface open: {:?}", table(&rows));
    assert!(!family(&rows, "bounded_section_volume").pass, "a dropped band loses half the section volume: {:?}", table(&rows));
}

// The same through the real kernel: M6 a (a 2 m bounded pocket in a 4 m box)
// gains two 2 m bands across the pocket and must pass as one solid.
#[test]
fn m6_7955_layered_bounded_bands_close_only_as_an_assembly() {
    let Some(worker) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "real SDK required");
        return;
    };
    let text = SOURCE.replace("ENDSEC;\nEND-ISO-10303-21;",
        "#5000=IFCMATERIAL('Band A',$,$);\n#5001=IFCMATERIAL('Band B',$,$);\n\
#5002=IFCMATERIALLAYER(#5000,2.,.F.,'Band A',$,$,$);\n#5003=IFCMATERIALLAYER(#5001,2.,.F.,'Band B',$,$,$);\n\
#5004=IFCMATERIALLAYERSET((#5002,#5003),'Two bands',$);\n#5005=IFCMATERIALLAYERSETUSAGE(#5004,.AXIS2.,.POSITIVE.,0.,$);\n\
#5006=IFCRELASSOCIATESMATERIAL('0000000000000000005006',$,$,$,(#1000),#5005);\nENDSEC;\nEND-ISO-10303-21;");
    assert!(text.contains("#5006="), "layer usage appended");
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(), None);
    let e = bounded::expected(text.as_bytes(), &sources, 1000).expect("bounded source expectation");
    assert!(e.section_volume.is_some(), "the pocket has an independent section volume");
    let mut outcomes = Vec::new();
    run_model_native(SourceBundle::new(text.as_bytes().to_vec()), &worker,
        &ModelOptions { ids: Some([1000].into_iter().collect()), ..Default::default() }, |o| outcomes.push(o)).unwrap();
    let Some(ProductOutcome::Published(shape)) = outcomes.pop() else { panic!("expected a published shape") };
    assert_eq!(shape.parts.iter().filter(|p| p.layer.is_some()).count(), 2, "both bands published");
    let t: serde_json::Value = serde_json::from_str(M6).unwrap();
    let rows = check_parts(1000, &shape.parts, Some(&e), &t, None, text.as_bytes());
    for name in ["bounded_closure", "bounded_section_volume", "bounded_volume_bounds", "bounded_outside_material"] {
        let row = family(&rows, name);
        assert!(row.gated && row.pass, "{name} must pass for the assembled bands: {:?}", table(&rows));
    }
    println!("sdk witness executed: m6_layered_bounded_assembly");
}
