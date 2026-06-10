// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Production fixture void matrix (split out of the former
//! `voids_matrix_test.rs`; shared helpers live in `voids_common`).
//!
//! [`production_fixture_walls_have_holes`] /
//! [`production_smiley_all_host_walls_have_holes`] are end-to-end fixture
//! reproductions of issues #604 and #584 that mimic the exact
//! `IfcAPI::process_geometry_batch` path:
//!   1. Parse the IFC bytes
//!   2. Build `void_index` from `IfcRelVoidsElement` (no manual ID injection)
//!   3. Drive each host element through `process_element_with_voids`
//!   4. Ray-cast through the opening footprint along the wall thickness axis
//!      to assert the wall actually has a hole. A SOLID UNCUT wall fails.
//!
//! Fixtures are reported regression cases:
//!   - `tests/models/various/issue-604-door.ifc` (issue #604, PR #605 head)
//!   - `tests/models/ara3d/AC-20-Smiley-West-10-Bldg.ifc` (issue #584)
//!
//! These tests are gated on the fixtures being present so CI without
//! large model downloads does not flake. Preserves every assertion from
//! the former `production_void_path_test.rs`.

mod voids_common;

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::GeometryRouter;
use voids_common::production::{
    build_void_index_like_production, count_hits_through_opening, find_entity_by_guid,
    load_fixture, opening_world_aabb, process_host_like_production,
};

/// How a production fixture case locates its host wall.
enum HostLocator {
    ById(u32),
    ByGuid(&'static str),
}

struct FixtureWallCase {
    name: &'static str,
    fixture: &'static str,
    host: HostLocator,
    /// When known, the exact opening IDs expected for the host.
    expected_openings: Option<&'static [u32]>,
}

/// Reproducers for issues #604 (single-wall door fixture, wall #55 /
/// opening #2438) and #584 (the user's host wall in Smiley-West, GUID
/// `0NQVcwUgj2fup5UuFaDTfC` → express #137010 with voids #137081/#137149).
#[test]
fn production_fixture_walls_have_holes() {
    let cases = [
        FixtureWallCase {
            name: "issue_604_door_wall_55",
            fixture: "tests/models/various/issue-604-door.ifc",
            host: HostLocator::ById(55),
            expected_openings: Some(&[2438]),
        },
        FixtureWallCase {
            name: "issue_584_smiley_wall_0NQVcwUgj2fup5UuFaDTfC",
            fixture: "tests/models/ara3d/AC-20-Smiley-West-10-Bldg.ifc",
            host: HostLocator::ByGuid("0NQVcwUgj2fup5UuFaDTfC"),
            expected_openings: None,
        },
    ];

    for case in &cases {
        let content = match load_fixture(case.fixture) {
            Some(c) => c,
            None => {
                eprintln!(
                    "[{}] fixture {} missing — skipping production void test",
                    case.name, case.fixture
                );
                continue;
            }
        };

        let host_id = match case.host {
            HostLocator::ById(id) => id,
            HostLocator::ByGuid(guid) => find_entity_by_guid(&content, guid)
                .unwrap_or_else(|| panic!("[{}] host GUID {guid} should be present", case.name)),
        };

        let void_index = build_void_index_like_production(&content);
        let opening_ids = void_index.get(&host_id).cloned().unwrap_or_else(|| {
            panic!(
                "[{}] host #{host_id} should be in void_index built from IfcRelVoidsElement",
                case.name
            )
        });
        assert!(
            !opening_ids.is_empty(),
            "[{}] host should have at least one opening in IfcRelVoidsElement",
            case.name
        );
        if let Some(expected) = case.expected_openings {
            assert_eq!(
                opening_ids, expected,
                "[{}] expected openings {expected:?} for host #{host_id}",
                case.name
            );
        }

        let wall_mesh = process_host_like_production(&content, host_id, &void_index)
            .unwrap_or_else(|| panic!("[{}] host #{host_id} should produce a mesh", case.name));
        assert!(
            !wall_mesh.is_empty(),
            "[{}] host #{host_id} produced an empty mesh — pre-existing regression",
            case.name
        );

        // Compute each opening AABB through the production opening path and
        // ray-cast its footprint; every opening must have a hole.
        let entity_index = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);
        let router = GeometryRouter::with_scale(1.0);

        let mut total_hits = 0usize;
        let mut checked = 0usize;
        for &opening_id in &opening_ids {
            let (op_min, op_max) = match opening_world_aabb(&router, opening_id, &mut decoder) {
                Some(b) => b,
                None => continue,
            };
            let hits = count_hits_through_opening(&wall_mesh, op_min, op_max);
            eprintln!(
                "[{}] opening #{opening_id}: {hits} ray-hits inside footprint",
                case.name
            );
            total_hits += hits;
            checked += 1;
        }
        assert!(
            checked > 0,
            "[{}] no opening footprints could be sampled",
            case.name
        );
        assert_eq!(
            total_hits,
            0,
            "[{}] wall (express #{host_id}) still has triangles inside opening footprints — \
             void cut was NOT applied. wall_tris={} openings={:?}",
            case.name,
            wall_mesh.triangle_count(),
            opening_ids,
        );
    }
}

/// Sweep ALL host walls in Smiley-West and report how many fail the
/// "wall has a hole" test. This is the production-coverage canary —
/// PR #626's "0 fallbacks" claim should mean `failed == 0` here.
#[test]
fn production_smiley_all_host_walls_have_holes() {
    let content = match load_fixture("tests/models/ara3d/AC-20-Smiley-West-10-Bldg.ifc") {
        Some(c) => c,
        None => {
            eprintln!(
                "AC-20-Smiley-West-10-Bldg.ifc fixture missing — \
                 skipping production void sweep"
            );
            return;
        }
    };

    let void_index = build_void_index_like_production(&content);
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_scale(1.0);

    let mut total_hosts = 0usize;
    let mut failed_hosts: Vec<(u32, usize, usize)> = Vec::new();
    let mut empty_meshes = 0usize;
    let mut skipped_no_opening_mesh = 0usize;

    for (&host_id, opening_ids) in void_index.iter() {
        let entity = match decoder.decode_by_id(host_id) {
            Ok(e) => e,
            Err(_) => continue,
        };
        // Only process host elements with their own representation; the
        // production code does the same gate.
        let has_repr = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
        if !has_repr {
            continue;
        }
        total_hosts += 1;

        let wall_mesh = match router.process_element_with_voids(&entity, &mut decoder, &void_index)
        {
            Ok(m) => m,
            Err(_) => continue,
        };
        if wall_mesh.is_empty() {
            empty_meshes += 1;
            continue;
        }

        let mut host_total_hits = 0usize;
        let mut host_checked = 0usize;
        for &opening_id in opening_ids {
            let (op_min, op_max) = match opening_world_aabb(&router, opening_id, &mut decoder) {
                Some(b) => b,
                None => {
                    skipped_no_opening_mesh += 1;
                    continue;
                }
            };
            let hits = count_hits_through_opening(&wall_mesh, op_min, op_max);
            host_total_hits += hits;
            host_checked += 1;
        }
        if host_checked > 0 && host_total_hits > 0 {
            failed_hosts.push((host_id, host_total_hits, host_checked));
        }
    }

    eprintln!(
        "[smiley sweep] hosts={} failed={} empty={} skipped_opening={}",
        total_hosts,
        failed_hosts.len(),
        empty_meshes,
        skipped_no_opening_mesh,
    );
    if !failed_hosts.is_empty() {
        eprintln!("first 20 failing hosts (express_id, total_hits, openings_checked):");
        for (id, hits, n) in failed_hosts.iter().take(20) {
            eprintln!("  #{}: {} hits across {} openings", id, hits, n);
        }
    }

    assert_eq!(
        failed_hosts.len(),
        0,
        "{}/{} host walls in Smiley-West are still uncut around their openings — \
         the production void path is not being applied",
        failed_hosts.len(),
        total_hosts,
    );
}
