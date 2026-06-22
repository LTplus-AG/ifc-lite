//! Verifies the analysis geometry-data export: welded, IFC Z-up, absolute-world
//! metres, occurrences only. Uses the synthetic analytic corpus (known coords).

use ifc_lite_processing::{build_geometry_data_export, process_geometry};

const FIXTURE: &str = "../../tests/models/synthetic_box.ifc";

fn bbox(v: &[[f64; 3]]) -> ([f64; 3], [f64; 3]) {
    let mut mn = [f64::INFINITY; 3];
    let mut mx = [f64::NEG_INFINITY; 3];
    for p in v {
        for i in 0..3 {
            mn[i] = mn[i].min(p[i]);
            mx[i] = mx[i].max(p[i]);
        }
    }
    (mn, mx)
}

fn approx(got: [f64; 3], want: [f64; 3], what: &str) {
    for i in 0..3 {
        assert!(
            (got[i] - want[i]).abs() < 1e-4,
            "{what}: axis {i} got {} want {}",
            got[i],
            want[i]
        );
    }
}

#[test]
fn geometry_data_export_is_welded_zup_world() {
    let src = match std::fs::read_to_string(FIXTURE) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("skip: fixture missing at {FIXTURE}");
            return;
        }
    };

    let result = process_geometry(&src);
    let rtc = result.metadata.coordinate_info.origin_shift;
    let export = build_geometry_data_export(&result.meshes, rtc);

    assert_eq!(export.schema, "ifc-lite-geometry-data");
    assert_eq!(export.up_axis, "Z");
    assert_eq!(export.units, "m");
    assert!(
        export.element_count >= 5,
        "expected >=5 occurrences, got {}",
        export.element_count
    );

    // cube #29: welded unit cube, absolute world [0,0,0]..[1,1,1], Z-up.
    let cube = export.elements.get(&29).expect("cube #29 present");
    assert_eq!(cube.ifc_type, "IfcBuildingElementProxy");
    assert_eq!(
        cube.vertices.len(),
        8,
        "cube should position-weld to 8 corners, got {}",
        cube.vertices.len()
    );
    assert_eq!(cube.faces.len(), 12, "cube = 12 triangles, got {}", cube.faces.len());
    let (mn, mx) = bbox(&cube.vertices);
    approx(mn, [0.0, 0.0, 0.0], "cube min");
    approx(mx, [1.0, 1.0, 1.0], "cube max");

    // tessellated control #114: cube at [40,0,0]..[41,1,1] (Z-up, world).
    let ctrl = export.elements.get(&114).expect("control #114 present");
    let (cmn, cmx) = bbox(&ctrl.vertices);
    approx(cmn, [40.0, 0.0, 0.0], "control min");
    approx(cmx, [41.0, 1.0, 1.0], "control max");

    // every face indexes in range and is non-degenerate.
    for (id, el) in &export.elements {
        let n = el.vertices.len() as u32;
        for f in &el.faces {
            assert!(
                f[0] < n && f[1] < n && f[2] < n,
                "#{id}: face index out of range"
            );
            assert!(
                f[0] != f[1] && f[1] != f[2] && f[0] != f[2],
                "#{id}: degenerate face survived weld"
            );
        }
    }

    // JSON contract round-trips with string id keys.
    let json = export.to_json().expect("serialize");
    assert!(json.contains("\"29\""), "cube id key present in JSON");
    assert!(json.contains("ifc-lite-geometry-data"));
}
