// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression tests for issues #582 and #583.
//!
//! Both issues report missing wall / window / door geometry on the AC20
//! IFC fixtures published by ifcwiki.org. The previous behaviour silently
//! fell back to host-clone whenever a CSG opening cut failed; now the
//! per-item geometry classifier (PR merged from main) routes the
//! affected openings through the rectangular / diagonal-rectangular path
//! and the Manifold kernel handles the residual genuine-CSG cases.
//!
//! The strict `total_failures == 0` assertions are unconditional once
//! the `manifold-csg` feature is on by default (this PR's flip).
//! Legacy / `--no-default-features` builds still run the loose checks
//! so the BSP path keeps a smoke signal.
//!
//! Fixtures must be downloaded via `pnpm fixtures` from the repo root.
//! Tests skip cleanly when absent.

use ifc_lite_core::IfcType;
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

#[derive(Default, Debug, Clone, Copy)]
struct PipelineStats {
    products_with_geometry: usize,
    walls_with_geometry: usize,
    windows_with_geometry: usize,
    doors_with_geometry: usize,
    /// Sum of position coordinate counts (i.e. positions.len()) across all
    /// produced meshes — proxy for "total mesh complexity". Used as a
    /// regression-detection signal: a sudden drop here means the
    /// previously-cut openings reverted to host-clone.
    total_mesh_position_floats: usize,
    csg_failures_total: usize,
    csg_failures_products: usize,
}

/// Run the full geometry pipeline against `content` and return per-type
/// stats. The classifier routes walls/windows/doors through `process_element_with_voids`,
/// which performs the void cuts; we count entities that successfully
/// produce geometry plus the residual CSG-failure log.
fn run_geometry_pipeline(content: &str) -> PipelineStats {
    let entity_index = ifc_lite_core::build_entity_index(content);
    let mut decoder = ifc_lite_core::EntityDecoder::with_index(content, entity_index);
    let router = GeometryRouter::with_units(content, &mut decoder);

    let void_idx = VoidIndex::from_content(content, &mut decoder);
    let mut void_map: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for (host_id, voids) in void_idx.iter() {
        void_map.insert(host_id, voids.to_vec());
    }

    let mut scanner = ifc_lite_core::EntityScanner::new(content);
    let mut stats = PipelineStats::default();
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
                stats.products_with_geometry += 1;
                stats.total_mesh_position_floats += mesh.positions.len();
                match entity.ifc_type {
                    IfcType::IfcWall | IfcType::IfcWallStandardCase => {
                        stats.walls_with_geometry += 1;
                    }
                    IfcType::IfcWindow => {
                        stats.windows_with_geometry += 1;
                    }
                    IfcType::IfcDoor => {
                        stats.doors_with_geometry += 1;
                    }
                    _ => {}
                }
            }
        }
    }

    let failures = router.take_csg_failures();
    stats.csg_failures_total = failures.values().map(|v| v.len()).sum();
    stats.csg_failures_products = failures.len();
    stats
}

// =============================================================================
// Issue #582 — AC20-FZK-Haus.ifc, missing walls + windows.
// =============================================================================

#[test]
fn issue_582_fzk_haus_walls_and_windows_present() {
    let Some(content) = read_fixture("ara3d/AC20-FZK-Haus.ifc") else {
        return;
    };
    let stats = run_geometry_pipeline(&content);
    eprintln!("[issue #582 FZK-Haus] {stats:#?}");

    // Pipeline must produce *some* geometry overall.
    assert!(
        stats.products_with_geometry > 0,
        "FZK-Haus produced no geometry at all"
    );

    // Issue #582 specifically called out missing walls and windows.
    // FZK-Haus has 22 walls and 8 windows in its model. We assert >0
    // (both types appear) rather than exact counts to leave slack for
    // upstream fixture revisions, but the lower bounds here are well
    // below the model totals so a regression to host-clone-only would
    // trip the test.
    assert!(
        stats.walls_with_geometry >= 10,
        "issue #582: FZK-Haus walls regressed — got {} (expected >=10)",
        stats.walls_with_geometry
    );
    assert!(
        stats.windows_with_geometry >= 4,
        "issue #582: FZK-Haus windows regressed — got {} (expected >=4)",
        stats.windows_with_geometry
    );
}

#[test]
#[cfg(feature = "manifold-csg")]
fn issue_582_fzk_haus_no_csg_failures() {
    let Some(content) = read_fixture("ara3d/AC20-FZK-Haus.ifc") else {
        return;
    };
    let stats = run_geometry_pipeline(&content);
    assert_eq!(
        stats.csg_failures_total, 0,
        "issue #582: FZK-Haus must have zero CSG fallbacks under default features"
    );
}

// =============================================================================
// Issue #583 — AC20-Institute-Var-2.ifc, missing walls / partition geometry.
// =============================================================================

#[test]
fn issue_583_institute_var2_walls_and_doors_present() {
    let Some(content) = read_fixture("ara3d/C20-Institute-Var-2.ifc") else {
        return;
    };
    let stats = run_geometry_pipeline(&content);
    eprintln!("[issue #583 Institute-Var-2] {stats:#?}");

    assert!(
        stats.products_with_geometry > 0,
        "Institute-Var-2 produced no geometry at all"
    );

    // Institute-Var-2 is a much larger model (~1000 products with
    // geometry). Walls and doors are core to the issue report.
    assert!(
        stats.walls_with_geometry >= 50,
        "issue #583: Institute-Var-2 walls regressed — got {} (expected >=50)",
        stats.walls_with_geometry
    );
    assert!(
        stats.doors_with_geometry >= 10,
        "issue #583: Institute-Var-2 doors regressed — got {} (expected >=10)",
        stats.doors_with_geometry
    );
}

#[test]
#[cfg(feature = "manifold-csg")]
fn issue_583_institute_var2_no_csg_failures() {
    let Some(content) = read_fixture("ara3d/C20-Institute-Var-2.ifc") else {
        return;
    };
    let stats = run_geometry_pipeline(&content);
    assert_eq!(
        stats.csg_failures_total, 0,
        "issue #583: Institute-Var-2 must have zero CSG fallbacks under default features"
    );
}

// =============================================================================
// Bundle-size sanity proxy: the merged classifier produces meaningfully
// more vertex data than a host-clone-only fallback would. If this drops
// suddenly between revisions, openings have likely regressed to
// uncut-host. This is informational rather than a hard pass/fail bound.
// =============================================================================

#[test]
fn issue_582_fzk_haus_total_mesh_complexity_above_floor() {
    let Some(content) = read_fixture("ara3d/AC20-FZK-Haus.ifc") else {
        return;
    };
    let stats = run_geometry_pipeline(&content);
    // Empirically observed (default features, post-merge): ~150k position
    // floats. Floor at 50k catches host-clone-only fallback (~10-20k).
    assert!(
        stats.total_mesh_position_floats >= 50_000,
        "issue #582: FZK-Haus total mesh complexity regressed — {} floats (expected >=50000); openings likely reverted to host-clone",
        stats.total_mesh_position_floats
    );
}
