// SPDX-License-Identifier: MPL-2.0
//! Actual canonical source-only API and Worker lifetime, never final-product proof.
use super::*;
use wasm_bindgen_test::*;
wasm_bindgen_test_configure!(run_in_browser);

const SOURCE: &str = include_str!("../../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");

fn source() -> String {
    SOURCE.replace("#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);", "#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);")
        .replace("#8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,1.0,1.0);", "#8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,2000.,4000.);")
        .replace("#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);", "#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,3000.);")
        .replace("#28=IFCCARTESIANPOINT((0.0,0.0,0.));", "#28=IFCCARTESIANPOINT((5000000000.,0.,0.));")
        .replace("#6=IFCCARTESIANPOINT((0.,0.));", "#6=IFCCARTESIANPOINT((250.,-500.));")
        .replace("#10=IFCCARTESIANPOINT((0.,0.,0.));", "#10=IFCCARTESIANPOINT((1000.,2000.,3000.));")
}

fn key(api: &IfcAPI) -> JsValue {
    let keys: Vec<serde_json::Value> = serde_wasm_bindgen::from_value(api.retained_source_keys().unwrap()).unwrap();
    let key = keys.into_iter().find(|key| key["solid_id"] == 12).unwrap();
    serde_wasm_bindgen::to_value(&key).unwrap()
}

#[derive(serde::Deserialize)]
struct Display {
    contract: String,
    positions: Vec<f32>,
    indices: Vec<u32>,
    occurrences: Vec<(u32, [f64; 16])>,
}

#[wasm_bindgen_test(async)]
async fn canonical_source_only_worker_units_survey_and_expiry() {
    let api = IfcAPI::new();
    assert!(api.retained_source_keys().is_err());
    let source = source();
    assert!(source.contains("5000000000."));
    api.set_source_bytes(source.into_bytes());
    api.bind_source_model().unwrap();
    let mut selected = api.admit_retained_source(key(&api)).unwrap();
    let mut executor = RetainedBrowserExecutor::new().unwrap();
    let cancellation = executor.cancellation();
    cancellation.retire();
    assert!(selected.execute(&mut executor, 0, 0.001, 5., 16 * 1024 * 1024).await.is_err());
    assert!(selected.display().is_err());
    selected = api.admit_retained_source(key(&api)).unwrap();
    executor = RetainedBrowserExecutor::new().unwrap();
    cancellation.retire(); // The old domain cannot retire its replacement.
    let display = selected.execute(&mut executor, 0, 0.001, 5., 16 * 1024 * 1024).await.unwrap();
    let display: Display = serde_wasm_bindgen::from_value(display).unwrap();
    assert_eq!(display.contract, "unstyled_flat_source_only");
    assert!(!display.indices.is_empty());
    assert_eq!(display.indices.len() % 3, 0);
    let mut six_volume = 0.;
    for triangle in display.indices.chunks_exact(3) {
        let point = |i: usize| {
            let offset = triangle[i] as usize * 3;
            std::array::from_fn::<_, 3, _>(|axis| f64::from(display.positions[offset + axis]))
        };
        let [a, b, c] = [point(0), point(1), point(2)];
        six_volume += a[0] * (b[1]*c[2]-b[2]*c[1]) + a[1] * (b[2]*c[0]-b[0]*c[2]) + a[2] * (b[0]*c[1]-b[1]*c[0]);
    }
    assert!((six_volume.abs()/6. - 24.).abs() < 1e-6, "actual source volume24m3; units applied once");
    let frame = &display.occurrences.iter().find(|(id, _)| *id == 31).unwrap().1;
    assert!((frame[3] - 5000000.25).abs() < 1e-8);
    assert!((frame[7] + 0.5).abs() < 1e-10);
    assert!((frame[11] - 3.).abs() < 1e-10);
    assert!(selected.display().is_ok());
    api.clear_pre_pass_cache();
    assert!(selected.display().is_err(), "canonical source invalidation expires publication");
}
