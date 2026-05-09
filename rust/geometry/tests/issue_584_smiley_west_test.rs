// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #584 — `AC-20-Smiley-West-10-Bldg.ifc`
//! balcony door openings not cut.
//!
//! This test mirrors `issue_582_583_regression_test.rs`: it runs the full
//! geometry pipeline against the Smiley-West fixture, drains
//! `BoolFailure`s from the router, and surfaces the count. The strict
//! `total_failures == 0` Sprint 2 gate is `#[cfg(feature = "manifold-csg")]`
//! since the legacy BSP path is known to fall back on this fixture (the
//! exact bug the migration fixes).
//!
//! ## Sourcing the fixture
//!
//! The IFC originates from `http://www.ifcwiki.org/index.php?title=File:Download-Smiley-West.png`
//! (zipped at `http://www.ifcwiki.org/images/c/c8/AC-20-Smiley-West-10-Bldg.zip`).
//! Once downloaded:
//!
//! ```sh
//! # 1. Drop the unzipped IFC under tests/models/ara3d/.
//! mv AC-20-Smiley-West-10-Bldg.ifc tests/models/ara3d/
//!
//! # 2. Regenerate the manifest (computes sha256 + size automatically).
//! pnpm fixtures:manifest
//!
//! # 3. Upload to the fixtures-v1 GitHub Release (requires write auth).
//! pnpm fixtures:upload
//! ```
//!
//! Until the fixture is in the manifest + release, `pnpm fixtures` will
//! not pull it and these tests will skip cleanly with a hint pointing to
//! this file. CI is unaffected.

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
                "skipping: fixture {path} not present. Source from ifcwiki.org and run \
                 `pnpm fixtures:manifest` then `pnpm fixtures:upload`. \
                 See `rust/geometry/tests/issue_584_smiley_west_test.rs` for the recipe."
            );
            None
        }
        Err(e) => panic!("failed to read fixture {path}: {e}"),
    }
}

/// Process every geometry-bearing product in `content` through the void
/// pipeline and return `(products_processed_with_geometry, total_csg_failures,
/// products_with_failures)`. Mirrors `issue_582_583_regression_test`.
fn run_geometry_pipeline(content: &str) -> (usize, usize, usize) {
    let entity_index = ifc_lite_core::build_entity_index(content);
    let mut decoder = ifc_lite_core::EntityDecoder::with_index(content, entity_index);
    let router = GeometryRouter::with_units(content, &mut decoder);

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
fn issue_584_smiley_west_pipeline_runs_and_records_failures() {
    let Some(content) = read_fixture("ara3d/AC-20-Smiley-West-10-Bldg.ifc") else {
        return;
    };
    let (produced, total_failures, products_with_failures) = run_geometry_pipeline(&content);
    eprintln!(
        "[issue #584 Smiley-West] geometry produced for {produced} products; \
         {total_failures} CSG failures across {products_with_failures} products"
    );
    assert!(produced > 0, "Smiley-West must yield some geometry");
}

/// Sprint 2 acceptance gate. Active only with `--features manifold-csg`:
/// the legacy BSP path is known to fall back to host-clone on this fixture
/// (the bug the migration fixes), so asserting `total_failures == 0` would
/// always fail there.
#[test]
#[cfg(feature = "manifold-csg")]
fn issue_584_smiley_west_no_csg_failures_after_manifold() {
    let Some(content) = read_fixture("ara3d/AC-20-Smiley-West-10-Bldg.ifc") else {
        return;
    };
    let (_, total_failures, _) = run_geometry_pipeline(&content);
    assert_eq!(
        total_failures, 0,
        "post-T1.1, no CSG fallbacks should fire on Smiley-West"
    );
}
