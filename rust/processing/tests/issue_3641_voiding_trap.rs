// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for #3641: subtracting three `IfcVoidingFeature` voids from a
//! single host in a sequential CSG chain traps the WASM instance with
//! "memory access out of bounds". Reported as reproducing only when all
//! three voids are present together (each void alone, and every pair, is
//! fine) — pointing at a degenerating intermediate result in the sequential
//! subtraction chain, not any single boolean op.
//!
//! This test drives the NATIVE (non-WASM) pipeline with the reporter's
//! minimal fixture to check whether the same underlying defect (a
//! degenerate/non-manifold intermediate feeding an out-of-range index) is
//! reachable without WASM at all, or whether it is WASM-memory-specific.

use ifc_lite_processing::process_geometry;

const FIXTURE: &str = "tests/fixtures/issue_3641_voiding_trap.ifc";

fn fixture_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(FIXTURE)
}

#[test]
fn three_void_sequential_chain_does_not_panic_or_corrupt_native() {
    let path = fixture_path();
    let content = std::fs::read_to_string(&path).expect("fixture must be checked in");

    // Must not panic. If the underlying defect is an OOB Rust index (not
    // WASM-memory-specific), this either panics natively (bounds-checked
    // Vec/slice indexing) or produces meshes with an out-of-range index
    // value, both of which are checked below.
    let result = process_geometry(content.as_str());

    eprintln!(
        "processed: {} meshes, {} CSG failures logged",
        result.meshes.len(),
        result.stats.total_csg_failures
    );

    for m in &result.meshes {
        let vertex_count = m.positions.len() / 3;
        for (i, &idx) in m.indices.iter().enumerate() {
            assert!(
                (idx as usize) < vertex_count,
                "mesh #{}: index[{i}] = {idx} is out of range for {vertex_count} vertices \
                 (positions.len() = {})",
                m.express_id,
                m.positions.len()
            );
        }
    }
}
