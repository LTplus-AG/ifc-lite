// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M11-I: real SDK key stability, source dimensions, no coverage change.
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::*;
use ifc_lite_retained_native::{block_on, NativeWorker};

#[test]
fn issue_7955_m11_i_native_64_byte_identical_mapped_occurrences() {
    let Some(worker) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "real SMLib required");
        eprintln!("SKIP M11-I native: set IFCLITE_SMLIB_WORKER; not SDK evidence");
        return;
    };
    let source = include_bytes!("../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
    let mut products = Vec::new();
    block_on(run_model(SourceBundle::new(source.to_vec()), &ModelOptions::default(),
        || NativeWorker::spawn(&worker), |outcome| products.push(outcome))).unwrap();
    assert_eq!(products.len(), 64);
    let parts: Vec<_> = products.iter().map(|p| match p {
        ProductOutcome::Published(s) => {
            assert_eq!(s.parts.len(), 1);
            assert_eq!(s.cuts, 0);
            (&s.parts[0], s.product_id)
        }
        other => panic!("missing mapped occurrence: {other:?}"),
    }).collect();
    let key = parts[0].0.instance_key.expect("mapped occurrence is eligible");
    for (part, _) in &parts {
        assert_eq!(part.instance_key, Some(key), "one byte-equal key, never tolerance matching");
        assert_eq!(part.indices, parts[0].0.indices);
        assert!(part.positions.iter().zip(&parts[0].0.positions).all(|(a,b)| a.to_bits() == b.to_bits()));
        // IFC #8 is a 1m square and #12 extrudes it 1m along Z.
        for axis in 0..3 {
            let min = part.positions.chunks_exact(3).map(|p| p[axis]).fold(f64::INFINITY, f64::min);
            let max = part.positions.chunks_exact(3).map(|p| p[axis]).fold(f64::NEG_INFINITY, f64::max);
            assert_eq!(max-min, 1.);
        }
        assert_eq!(part.indices.len(), 36, "12 triangles per source cube");
    }
    let key_hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
    let reference = serde_json::json!({ "key":key_hex, "groups":1, "occurrences":64,
        "triangles":64*12, "ids":parts.iter().map(|(_,id)| id).collect::<Vec<_>>() });
    println!("M11-I native: {reference}");
    if let Some(path) = std::env::var_os("IFCLITE_M11_I_REFERENCE") {
        std::fs::write(path, serde_json::to_vec_pretty(&reference).unwrap()).unwrap();
    }
    println!("sdk witness executed: m11_i_mapped_instances");
}
