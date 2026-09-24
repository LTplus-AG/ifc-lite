// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5770: real JS/WASM boundary contract for exact swept-disk descriptions.
//! Run with `wasm-pack test --node rust/wasm-bindings --test swept_disk_descriptions`.

#![cfg(target_arch = "wasm32")]

use ifc_lite_wasm::IfcAPI;
use js_sys::JSON;
use serde_json::Value;
use wasm_bindgen::JsValue;
use wasm_bindgen_test::wasm_bindgen_test;

const LINE: &[u8] = include_bytes!("../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc");
const L_BAR: &[u8] =
    include_bytes!("../../geometry/tests/fixtures/swept_disk_composite_arc_lbar.ifc");
const U_BAR: &[u8] =
    include_bytes!("../../geometry/tests/fixtures/swept_disk_composite_arc_ubar.ifc");
const CRANK: &[u8] =
    include_bytes!("../../geometry/tests/fixtures/swept_disk_composite_arc_crankbar.ifc");

fn json(value: JsValue) -> Value {
    let text = JSON::stringify(&value).unwrap().as_string().unwrap();
    serde_json::from_str(&text).unwrap()
}

fn assert_near(actual: &Value, expected: f64) {
    let actual = actual.as_f64().unwrap();
    assert!(
        (actual - expected).abs() < 1e-9,
        "expected {expected}, got {actual}"
    );
}

#[wasm_bindgen_test]
fn directrix_and_metrics_survive_the_wasm_boundary() {
    let api = IfcAPI::new();
    for (source, id, lengths, bend_count) in [
        (LINE, 50, 1, 0),
        (L_BAR, 78, 3, 1),
        (U_BAR, 125, 5, 2),
        (CRANK, 79, 5, 2),
    ] {
        let document = json(api.extract_swept_disk_descriptions(source, None).unwrap());
        assert_eq!(document["up_axis"], "Z");
        assert_eq!(document["units"], "m");
        assert_eq!(document["coordinate_space"], "absolute_ifc_world");
        assert_eq!(document["diagnostics"], serde_json::json!([]));
        let key = id.to_string();
        let disk = &document["elements"][&key][0];
        assert_eq!(disk["status"]["type"], "complete");
        assert_eq!(disk["Directrix"].as_array().unwrap().len(), lengths);
        assert_eq!(
            disk["directrix_metrics"]["segments"]
                .as_array()
                .unwrap()
                .len(),
            lengths
        );
        assert_eq!(
            disk["directrix_metrics"]["segments"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| !entry["bend_angle"].is_null())
                .count(),
            bend_count
        );
        assert!(disk["directrix_metrics"]["total_length"].as_f64().unwrap() > 0.0);
        assert!(disk["InnerRadius"].is_null());
        if id == 125 {
            let segments = &disk["directrix_metrics"]["segments"];
            assert_near(&segments[0]["length"], 0.322);
            assert_near(&segments[1]["bend_angle"], std::f64::consts::FRAC_PI_2);
            assert_near(&segments[1]["length"], 0.1015 * std::f64::consts::FRAC_PI_2);
            assert_near(&segments[2]["length"], 0.245685133619932);
            assert_near(&segments[3]["bend_angle"], std::f64::consts::FRAC_PI_2);
            assert_near(&segments[4]["length"], 0.250);
        }
    }
}

#[wasm_bindgen_test]
fn ids_filter_and_mapped_world_scale_are_preserved() {
    let api = IfcAPI::new();
    let all = json(api.extract_swept_disk_descriptions(LINE, None).unwrap());
    assert_near(
        &all["elements"]["50"][0]["directrix_metrics"]["total_length"],
        2.75,
    );

    let none = json(
        api.extract_swept_disk_descriptions(LINE, Some(vec![]))
            .unwrap(),
    );
    assert_eq!(none["elements"], serde_json::json!({}));

    let unknown = json(
        api.extract_swept_disk_descriptions(LINE, Some(vec![43]))
            .unwrap(),
    );
    assert_eq!(unknown["elements"], serde_json::json!({}));

    let selected = json(
        api.extract_swept_disk_descriptions(LINE, Some(vec![50]))
            .unwrap(),
    );
    assert_eq!(selected["elements"].as_object().unwrap().len(), 1);

    let source = String::from_utf8(LINE.to_vec()).unwrap().replace(
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);",
        "#1000=IFCCARTESIANPOINT((1000.,0.,0.));\n#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1000,2.,$);",
    );
    let mapped = json(
        api.extract_swept_disk_descriptions(source.as_bytes(), Some(vec![50]))
            .unwrap(),
    );
    let disk = &mapped["elements"]["50"][0];
    assert_near(&disk["Radius"], 0.029);
    assert_near(&disk["Directrix"][0]["start"][0], 1.0);
    assert_near(&disk["Directrix"][0]["end"][0], 6.5);
    assert_near(&disk["directrix_metrics"]["total_length"], 5.5);
}

#[wasm_bindgen_test]
fn unsupported_and_large_world_coordinates_retain_contract() {
    let api = IfcAPI::new();
    let source = String::from_utf8(LINE.to_vec()).unwrap().replace(
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);",
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#10,$,$,2.,1.);",
    );
    let unsupported = json(
        api.extract_swept_disk_descriptions(source.as_bytes(), None)
            .unwrap(),
    );
    let disk = &unsupported["elements"]["50"][0];
    assert_eq!(disk["status"]["type"], "unsupported");
    assert!(disk["status"]["reason"].is_string());
    assert_eq!(disk["Directrix"], serde_json::json!([]));
    assert!(disk["directrix_metrics"].is_null());

    let large = String::from_utf8(LINE.to_vec()).unwrap().replace(
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);",
        "#1000=IFCCARTESIANPOINT((5000000123.456,0.,0.));\n#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1000,$,$);",
    );
    let large = json(
        api.extract_swept_disk_descriptions(large.as_bytes(), None)
            .unwrap(),
    );
    let start = &large["elements"]["50"][0]["Directrix"][0]["start"][0];
    // Source coordinates are millimetres; the world-metre offset retains
    // sub-millimetre resolution even at a 5,000 km georeferenced location.
    assert_near(start, 5_000_000.123_456);
}
