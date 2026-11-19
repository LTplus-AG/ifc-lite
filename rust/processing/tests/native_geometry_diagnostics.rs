// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The native geometry pass aggregates the full `GeometryDiagnostics` contract
//! into `ProcessingStats.geometry_diagnostics` — parity with the WASM batch path,
//! which already surfaces the same shape. AC20-FZK-Haus has windows and doors cut
//! into walls, so a real opening-classification + per-host diagnostic must appear.

use ifc_lite_processing::process_geometry;

const FIXTURE: &str = "ara3d/AC20-FZK-Haus.ifc";

#[test]
fn native_pass_surfaces_geometry_diagnostics() {
    // ara3d fixtures are not committed; skip cleanly when absent (AGENTS.md test
    // convention, matching issue_1320_wall_67828_round_window).
    let bytes = ifc_lite_testkit::fixture_bytes_or_skip!(FIXTURE);
    let result = process_geometry(&bytes);

    let diag = result
        .stats
        .geometry_diagnostics
        .as_ref()
        .expect("a model with openings must surface geometry_diagnostics");

    // The contract carries the compatibility handshake on the native path too.
    assert_eq!(
        diag.schema_version,
        6,
        "native diagnostics must be version-stamped"
    );

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

#[test]
fn equal_triangle_counts_do_not_hide_a_real_rectangular_cut_10510() {
    use ifc_lite_processing::{process, ProcessingRequest};
    use ifc_lite_testkit::mesh::signed_volume;
    use std::sync::Arc;

    let bytes = ifc_lite_testkit::fixture_bytes_or_skip!("ara3d/FM_ARC_DigitalHub.ifc");
    for (host, expected_no_ops) in [(61_530, 0), (216_340, 1)] {
        let request = ProcessingRequest::full_pass().ids(Some(Arc::new([host].into())));
        let gross = process(&bytes, &request.clone().skip_voids(true), &mut ());
        let cut = process(&bytes, &request, &mut ());
        let volume = |meshes: &[ifc_lite_processing::MeshData]| {
            meshes.iter()
                .map(|mesh| signed_volume(&mesh.positions, &mesh.indices).abs())
                .sum::<f64>()
        };
        let gross_volume = volume(&gross.meshes);
        let cut_volume = volume(&cut.meshes);
        assert!(gross_volume > 0.0, "fixture host #{host} must mesh");
        if expected_no_ops == 0 {
            assert!(cut_volume < 0.75 * gross_volume, "host #{host} must have a real cut");
        } else {
            assert!((cut_volume - gross_volume).abs() < 0.001 * gross_volume);
        }

        let diagnostics = cut.stats.geometry_diagnostics.expect("opening diagnostics");
        assert!(diagnostics.classification.rectangular > 0, "host #{host}");
        assert_eq!(diagnostics.total_csg_failures, 0, "host #{host}");
        assert_eq!(diagnostics.silent_no_ops, expected_no_ops, "host #{host}");
    }
}
