// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `determinism::diff_report` (#1549). Split into its own
//! `_tests.rs` sibling file (declared from `lib.rs`, not from inside
//! `determinism.rs` itself) so it doesn't count against `determinism.rs`'s
//! `module_size_ratchet` budget, which already sits exactly at its frozen
//! limit.

use crate::determinism::*;

/// A minimal, internally-consistent manifest for `diff_report` unit tests.
/// The exact hash strings are arbitrary placeholders (never real FNV-1a
/// output) - only their equality/inequality across two manifests matters.
fn manifest(hash: &str, voids_hash: &str, mesh_positions_hash: &str) -> MeshManifest {
    MeshManifest {
        hash: hash.to_string(),
        mesh_count: 1,
        vertex_count: 3,
        triangle_count: 1,
        voids_hash: voids_hash.to_string(),
        void_host_count: 2,
        material_colors_hash: "0xaaaa".to_string(),
        material_element_count: 2,
        styles_hash: "0xbbbb".to_string(),
        style_entry_count: 2,
        meshes: vec![MeshManifestEntry {
            express_id: 100,
            geometry_class: 0,
            vertex_count: 3,
            triangle_count: 1,
            positions_hash: mesh_positions_hash.to_string(),
            normals_hash: "0xcccc".to_string(),
            indices_origin_hash: "0xdddd".to_string(),
        }],
    }
}

/// #1549: `diff_report` had zero unit coverage. Diverge exactly two known
/// top-level fields (`hash`, `voids_hash`) and assert the report names
/// BOTH by field name, and does not falsely name an unrelated field
/// (`positions_hash`, which is unchanged here).
#[test]
fn diff_report_names_the_diverged_top_level_fields() {
    let expected = manifest("0x1", "0xv1", "0xp1");
    let actual = manifest("0x2", "0xv2", "0xp1");
    let report = diff_report(&expected, &actual).expect("manifests differ, must report");
    assert!(
        report.contains("hash: expected 0x1 got 0x2"),
        "must name the top-level hash field:\n{report}"
    );
    assert!(
        report.contains("voids_hash: expected 0xv1 got 0xv2"),
        "must name voids_hash:\n{report}"
    );
    assert!(
        !report.contains("positions_hash"),
        "positions_hash is unchanged and must not be reported:\n{report}"
    );
}

/// A per-mesh divergence (only `positions_hash` on mesh index 0 differs)
/// must be named both by mesh index and by the specific sub-field.
#[test]
fn diff_report_names_the_diverged_mesh_subfield() {
    let expected = manifest("0x1", "0xv1", "0xp1");
    let mut actual = expected.clone();
    actual.meshes[0].positions_hash = "0xp2".to_string();
    // The top-level `hash` also necessarily changes with any mesh delta
    // in production, but this test only mutates the per-mesh field, so
    // top-level `hash` stays equal here - isolating the per-mesh path.
    let report = diff_report(&expected, &actual).expect("mesh entry differs, must report");
    assert!(
        report.contains("mesh[0]"),
        "must identify which mesh index diverged:\n{report}"
    );
    assert!(
        report.contains("positions"),
        "must name the diverged mesh sub-field:\n{report}"
    );
}

#[test]
fn diff_report_is_none_when_manifests_match() {
    let m = manifest("0x1", "0xv1", "0xp1");
    assert!(diff_report(&m, &m).is_none());
}
