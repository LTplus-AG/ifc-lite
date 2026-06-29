// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The native geometry pass aggregates the full `GeometryDiagnostics` contract
//! into `ProcessingStats.geometry_diagnostics` — parity with the WASM batch path,
//! which already surfaces the same shape. AC20-FZK-Haus has windows and doors cut
//! into walls, so a real opening-classification + per-host diagnostic must appear.

use ifc_lite_processing::process_geometry;

const FIXTURE: &str = "tests/models/ara3d/AC20-FZK-Haus.ifc";

fn fixture_path(relative: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(relative)
}

#[test]
fn native_pass_surfaces_geometry_diagnostics() {
    // ara3d fixtures are not committed; skip cleanly when absent (AGENTS.md test
    // convention, matching issue_1320_wall_67828_round_window).
    let bytes = match std::fs::read(fixture_path(FIXTURE)) {
        Ok(b) => b,
        Err(_) => {
            eprintln!("{FIXTURE} missing - skipping");
            return;
        }
    };
    let result = process_geometry(&bytes);

    let diag = result
        .stats
        .geometry_diagnostics
        .as_ref()
        .expect("a model with openings must surface geometry_diagnostics");

    // Openings were classified (the model has windows/doors cut into walls).
    assert!(
        diag.classification.total > 0,
        "expected classified openings, got {:?}",
        diag.classification
    );
    assert!(diag.hosts_with_openings > 0, "expected hosts with openings");

    // The scalar legacy fields and the full contract agree on the failure total
    // (built from the same drained csg_failures map).
    assert_eq!(
        diag.total_csg_failures, result.stats.total_csg_failures,
        "diagnostics + legacy scalar failure totals must match"
    );
    assert_eq!(
        diag.products_with_failures, result.stats.products_with_failures,
        "diagnostics + legacy scalar product-failure counts must match"
    );

    // classification.total is the sum of the three classified buckets.
    assert_eq!(
        diag.classification.total,
        diag.classification.rectangular
            + diag.classification.diagonal
            + diag.classification.non_rectangular,
        "classification.total is the bucket sum"
    );

    // The contract is only attached when non-empty; presence implies activity.
    assert!(!diag.is_empty(), "attached diagnostics are non-empty by construction");
}
