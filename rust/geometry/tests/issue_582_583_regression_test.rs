// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression tests for issues #582, #583, #584.
//!
//! These exercise the full geometry pipeline against ara3d / IFCwiki test
//! fixtures, drain `BoolFailure`s from the router, and surface the count.
//! Today the assertions are loose (no-crash + bounds-check the count) — the
//! whole point of T1.3 is to *expose* the silent failures rather than
//! pretend they don't exist. Strict `== 0` versions are tagged `#[ignore]`
//! and become the green signal once Sprint 2 (Manifold migration) lands.
//!
//! Fixtures must be downloaded via `pnpm fixtures` from the repo root. Tests
//! skip cleanly when absent.

use ifc_lite_geometry::{GeometryRouter, VoidIndex};
use rustc_hash::FxHashMap;

fn read_fixture(rel: &str) -> Option<String> {
    let path = format!("../../tests/models/{}", rel);
    match std::fs::read_to_string(&path) {
        Ok(s) if s.starts_with("version https://git-lfs.github.com/spec/") => {
            eprintln!(
                "skipping: fixture {path} is a Git LFS pointer; run `pnpm fixtures` from the repo root"
            );
            None
        }
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping: fixture {path} not present; run `pnpm fixtures` to download (manifest at tests/models/manifest.json)"
            );
            None
        }
        Err(e) => panic!("failed to read fixture {path}: {e}"),
    }
}

/// Process every geometry-bearing product in `content` through the void
/// pipeline and return `(products_processed_with_geometry, total_csg_failures,
/// products_with_failures)`.
fn run_geometry_pipeline(content: &str) -> (usize, usize, usize) {
    let entity_index = ifc_lite_core::build_entity_index(content);
    let mut decoder = ifc_lite_core::EntityDecoder::with_index(content, entity_index);
    let router = GeometryRouter::with_units(content, &mut decoder);

    // Build the host -> openings map exactly like wasm-bindings does.
    let void_idx = VoidIndex::from_content(content, &mut decoder);
    let mut void_map: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for (host_id, voids) in void_idx.iter() {
        void_map.insert(host_id, voids.to_vec());
    }

    let mut scanner = ifc_lite_core::EntityScanner::new(content);
    let mut produced = 0usize;
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if !ifc_lite_core::has_geometry_by_name(type_name) {
            continue;
        }
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };
        // Need a representation attribute to be worth processing.
        let has_rep = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
        if !has_rep {
            continue;
        }
        if let Ok(mesh) = router.process_element_with_voids(&entity, &mut decoder, &void_map) {
            if !mesh.is_empty() {
                produced += 1;
            }
        }
    }

    let failures = router.take_csg_failures();
    let total: usize = failures.values().map(|v| v.len()).sum();
    let products = failures.len();
    (produced, total, products)
}

#[test]
fn issue_582_fzk_haus_pipeline_runs_and_records_failures() {
    let Some(content) = read_fixture("ara3d/AC20-FZK-Haus.ifc") else {
        return;
    };
    let (produced, total_failures, products_with_failures) = run_geometry_pipeline(&content);
    eprintln!(
        "[issue #582 FZK-Haus] geometry produced for {produced} products; \
         {total_failures} CSG failures across {products_with_failures} products"
    );

    // Today's expectations (T1.3 just landed; Sprint 2 still pending):
    // - Pipeline must not crash → produced > 0.
    // - Failures may be present → no upper-zero assertion yet.
    assert!(produced > 0, "FZK-Haus must yield some geometry");
}

#[test]
fn issue_583_institute_var2_pipeline_runs_and_records_failures() {
    let Some(content) = read_fixture("ara3d/C20-Institute-Var-2.ifc") else {
        return;
    };
    let (produced, total_failures, products_with_failures) = run_geometry_pipeline(&content);
    eprintln!(
        "[issue #583 Institute-Var-2] geometry produced for {produced} products; \
         {total_failures} CSG failures across {products_with_failures} products"
    );
    assert!(produced > 0, "Institute-Var-2 must yield some geometry");
}

// -----------------------------------------------------------------------
// Sprint-2 acceptance gates. These are tagged `#[ignore]` until Manifold
// (T1.1) replaces the legacy BSP. When the migration lands, the cap-exceeded
// and silent-fallback paths should disappear and these flip to green.
// Re-enable by removing the `#[ignore]` attribute. Refer to the Tier 1-4
// plan in the parity-gap report.
// -----------------------------------------------------------------------

#[test]
#[ignore = "Sprint 2 acceptance gate — re-enable after T1.1 (Manifold migration). Tracks #582."]
fn issue_582_fzk_haus_no_csg_failures_after_manifold() {
    let Some(content) = read_fixture("ara3d/AC20-FZK-Haus.ifc") else {
        return;
    };
    let (_, total_failures, _) = run_geometry_pipeline(&content);
    assert_eq!(total_failures, 0, "post-T1.1, no CSG fallbacks should fire on FZK-Haus");
}

#[test]
#[ignore = "Sprint 2 acceptance gate — re-enable after T1.1 (Manifold migration). Tracks #583."]
fn issue_583_institute_var2_no_csg_failures_after_manifold() {
    let Some(content) = read_fixture("ara3d/C20-Institute-Var-2.ifc") else {
        return;
    };
    let (_, total_failures, _) = run_geometry_pipeline(&content);
    assert_eq!(
        total_failures, 0,
        "post-T1.1, no CSG fallbacks should fire on Institute-Var-2"
    );
}
