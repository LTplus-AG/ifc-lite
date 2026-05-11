// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #584 — `AC-20-Smiley-West-10-Bldg.ifc`
//! balcony door openings not cut.
//!
//! With the per-item geometry classifier (merged from main) and Manifold
//! on by default, the openings on this fixture are cut cleanly: zero
//! `BoolFailure`s drained from the router, doors and windows count above
//! the previously-broken floor.
//!
//! ## Sourcing the fixture
//!
//! The IFC originates from `http://www.ifcwiki.org/index.php?title=File:Download-Smiley-West.png`
//! (zipped at `http://www.ifcwiki.org/images/c/c8/AC-20-Smiley-West-10-Bldg.zip`).
//! Once downloaded, drop `AC-20-Smiley-West-10-Bldg.ifc` under
//! `tests/models/ara3d/`. Tests skip cleanly when the fixture is absent.

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
                "skipping: fixture {path} not present. Source from ifcwiki.org and drop \
                 under tests/models/ara3d/. See `rust/geometry/tests/issue_584_smiley_west_test.rs` \
                 for the recipe."
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
    total_mesh_position_floats: usize,
    csg_failures_total: usize,
    csg_failures_products: usize,
}

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

#[test]
fn issue_584_smiley_west_doors_and_walls_present() {
    let Some(content) = read_fixture("ara3d/AC-20-Smiley-West-10-Bldg.ifc") else {
        return;
    };
    let stats = run_geometry_pipeline(&content);
    eprintln!("[issue #584 Smiley-West] {stats:#?}");

    assert!(
        stats.products_with_geometry > 0,
        "Smiley-West produced no geometry at all"
    );

    // Issue #584 specifically called out balcony door openings not being
    // cut. Smiley-West is a 10-building model with hundreds of doors.
    // Floor at 50 catches a regression to host-clone (which would still
    // emit walls but stop emitting cut doors).
    assert!(
        stats.walls_with_geometry >= 100,
        "issue #584: Smiley-West walls regressed — got {} (expected >=100)",
        stats.walls_with_geometry
    );
    assert!(
        stats.doors_with_geometry >= 50,
        "issue #584: Smiley-West doors regressed — got {} (expected >=50)",
        stats.doors_with_geometry
    );
}

#[test]
#[cfg(feature = "manifold-csg")]
fn issue_584_smiley_west_no_csg_failures() {
    let Some(content) = read_fixture("ara3d/AC-20-Smiley-West-10-Bldg.ifc") else {
        return;
    };
    let stats = run_geometry_pipeline(&content);
    assert_eq!(
        stats.csg_failures_total, 0,
        "issue #584: Smiley-West must have zero CSG fallbacks under default features"
    );
}

#[test]
fn issue_584_smiley_west_total_mesh_complexity_above_floor() {
    let Some(content) = read_fixture("ara3d/AC-20-Smiley-West-10-Bldg.ifc") else {
        return;
    };
    let stats = run_geometry_pipeline(&content);
    // Empirically observed (default features): ~1.4M position floats.
    // Floor at 500k catches host-clone-only fallback or a wholesale
    // classification regression.
    assert!(
        stats.total_mesh_position_floats >= 500_000,
        "issue #584: Smiley-West total mesh complexity regressed — {} floats (expected >=500000)",
        stats.total_mesh_position_floats
    );
}
