// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #1910's fourth discovery path: the
//! `emit_quick_metadata_bootstrap` streaming entry
//! (`process_geometry_streaming_with_options_and_bootstrap`,
//! `StreamingOptions.emit_quick_metadata_bootstrap: true`).
//!
//! `rust/geometry/tests/issue_1910_storey_generalization.rs` locks the
//! container-geometry exception (`processor/mod.rs:740-767`) at the level of
//! the raw scan, and `rust/wasm-bindings/src/api/gpu_meshes/prepass_discovery.rs`
//! / `rust/wasm-bindings/src/api/styling/prepass.rs` lock the sharded and
//! `combined_pre_pass` discovery paths — but neither exercises the actual
//! production entry point a caller uses when it wants the quick-metadata
//! spatial-tree bootstrap alongside the geometry scan. The bug this PR fixes
//! was exactly "one discovery path didn't know" about the exception; this is
//! the fourth path enumerated in review, so it gets its own pinned test
//! rather than relying on the other three by inference.
//!
//! Uses the `IfcBuildingStorey` fixture, not the `IfcBuilding` one: `IfcBuilding`
//! is now exempted from `has_geometry_by_name` class-wide by the merged
//! upstream fix (#1969), so a building-geometry job would be scheduled by the
//! FIRST branch of the scan regardless of whether the exception branch below
//! works at all -- that would make this test pass even if the exception itself
//! were broken. `IfcBuildingStorey` stays blocked by name, so reaching its job
//! here can only happen through the exception branch actually firing.
//!
//! The load-bearing assertion is that the container's geometry job is still
//! scheduled and produces a mesh when the bootstrap is on — the entity-job
//! push in the exception branch is unconditional, and it must stay that way
//! even though the same branch deliberately skips the `quick_element_summaries`
//! insert (a future refactor that gated the push itself on
//! `quick_metadata_enabled`, mistaking it for the summary-insert guard right
//! above it, would break bootstrap-mode meshing while leaving
//! `process_geometry`'s non-bootstrap default untouched -- exactly the kind
//! of divergence issue #1910 was about).

use ifc_lite_processing::{
    process_geometry_streaming_with_options_and_bootstrap, QuickMetadataBootstrap, StreamingOptions,
};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../geometry/tests/fixtures/issue_1910_storey_shell_geometry.ifc"
);

fn read_fixture() -> Vec<u8> {
    std::fs::read(FIXTURE).expect("issue_1910 storey fixture must be present")
}

#[test]
fn bootstrap_path_still_schedules_and_meshes_the_container_geometry() {
    let content = read_fixture();
    let mut captured: Option<QuickMetadataBootstrap> = None;
    let options = StreamingOptions {
        emit_quick_metadata_bootstrap: true,
        ..Default::default()
    };

    let result = process_geometry_streaming_with_options_and_bootstrap(
        &content,
        options,
        |_, _, _| {},
        |_| {},
        |b| captured = Some(b.clone()),
    );

    // #40 is the IFCBUILDINGSTOREY entity carrying the IfcShellBasedSurfaceModel
    // (same fixture, same express id as the geometry-crate generalisation test).
    let storey_mesh = result
        .meshes
        .iter()
        .find(|m| m.express_id == 40)
        .unwrap_or_else(|| {
            let seen: Vec<(u32, &str)> = result
                .meshes
                .iter()
                .map(|m| (m.express_id, m.ifc_type.as_str()))
                .collect();
            panic!(
                "with emit_quick_metadata_bootstrap on, IFCBUILDINGSTOREY #40's \
                 geometry job must still be scheduled and meshed via the \
                 instance-level exception; got meshes {seen:?}"
            )
        });
    assert!(
        !storey_mesh.positions.is_empty() && !storey_mesh.indices.is_empty(),
        "the container's mesh must have real geometry, not an empty placeholder"
    );

    let boot = captured.expect("a quick-metadata bootstrap should be emitted");
    assert!(
        boot.entity_count > 0,
        "the bootstrap should have scanned the fixture's entities"
    );
}
