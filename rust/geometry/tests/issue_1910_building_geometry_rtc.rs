// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #1910: an IFC4X2 file whose only geometry is
//! attached directly to `IfcBuilding` (an `IfcShellBasedSurfaceModel` with
//! raw UTM-scale vertex coordinates, no `IfcMapConversion` offset, and
//! identity placements throughout) loaded with correct metadata/hierarchy
//! but rendered NO visible geometry.
//!
//! Root cause: `has_geometry_by_name("IFCBUILDING")` is hard-coded `false`
//! (it treats `IfcBuilding` as a pure hierarchy node) so the entity-job scan
//! in `rust/processing/src/processor/mod.rs` (server) and
//! `rust/wasm-bindings/src/api/gpu_meshes/prepass.rs` (browser/wasm) never
//! schedules the building's `IfcProductDefinitionShape` for meshing at all —
//! independent of RTC. As a side effect, `detect_rtc_offset_from_first_element`
//! (which scans the same `has_geometry_by_name`-filtered entity set) also
//! samples zero translations and reports a `(0, 0, 0)` offset for this file,
//! matching the symptom reported in the issue.
//!
//! Fixture: `fixtures/issue_1910_building_shell_geometry.ifc` — a minimal
//! synthetic equivalent of the reporter's `dgm_4x2.ifc` (not committed here;
//! it was emailed directly to the maintainer). Eastings ~500 000, northings
//! ~5 400 000 (UTM zone 32N scale), all placements identity, geometry hangs
//! off `IFCBUILDING` rather than a building element.

use ifc_lite_core::{build_entity_index, has_geometry_by_name, EntityDecoder, EntityScanner};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/issue_1910_building_shell_geometry.ifc"
);

fn read_fixture() -> String {
    std::fs::read_to_string(FIXTURE).expect("issue_1910 fixture must be present")
}

/// `has_geometry_by_name` alone never schedules `IFCBUILDING` for meshing —
/// that part of the exclusion is intentional and unchanged (most files' 
/// `IfcBuilding` has a null Representation). The fix is instance-level: 
/// `is_representationless_spatial_container_by_name` + a cheap non-null
/// Representation check (attribute 6) lets the job-collection scan catch the
/// exceptional case where a spatial container DOES carry real geometry.
#[test]
fn building_excluded_by_name_but_scheduled_when_it_has_a_representation() {
    let content = read_fixture();

    assert!(
        !has_geometry_by_name("IFCBUILDING"),
        "sanity: IFCBUILDING must stay excluded from has_geometry_by_name by \
         default — this is an intentional, unchanged invariant"
    );
    assert!(
        ifc_lite_core::is_representationless_spatial_container_by_name("IFCBUILDING"),
        "sanity: IFCBUILDING must be recognised as a normally-representationless \
         spatial container"
    );

    // Locate the IFCBUILDING entity's raw bytes in the fixture and confirm
    // the instance-level Representation check now catches it.
    let mut scanner = EntityScanner::new(&content);
    let mut found = false;
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCBUILDING" {
            found = true;
            assert!(
                ifc_lite_core::nth_attribute_is_present(&content.as_bytes()[start..end], 6),
                "entity #{id}: expected this fixture's IFCBUILDING to carry a \
                 non-null Representation (attribute 6)"
            );
        }
    }
    assert!(found, "fixture must contain an IFCBUILDING entity");
}

/// End-to-end: the production job-collection scan (replicated here exactly
/// as `rust/processing/src/processor/mod.rs` and
/// `rust/wasm-bindings/src/api/gpu_meshes/prepass.rs` do it) must schedule
/// the building for meshing, and meshing it must produce actual triangles.
#[test]
fn building_only_geometry_is_scheduled_and_meshes() {
    let content = read_fixture();
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let mut scanner = EntityScanner::new(&content);
    let mut scheduled_ids: Vec<u32> = Vec::new();
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        let scheduled = has_geometry_by_name(type_name)
            || (ifc_lite_core::is_representationless_spatial_container_by_name(type_name)
                && ifc_lite_core::nth_attribute_is_present(
                    &content.as_bytes()[start..end],
                    6,
                ));
        if scheduled {
            scheduled_ids.push(id);
        }
    }

    // #40 is the IFCBUILDING entity carrying the IfcShellBasedSurfaceModel.
    assert!(
        scheduled_ids.contains(&40),
        "expected IFCBUILDING #40 to be scheduled for meshing, got {scheduled_ids:?}"
    );

    let entity = decoder.decode_by_id(40).expect("IFCBUILDING #40 must decode");
    let mesh = router
        .process_element(&entity, &mut decoder)
        .expect("building shell geometry should mesh");
    assert!(
        !mesh.positions.is_empty() && !mesh.indices.is_empty(),
        "expected the building's shell geometry to produce a non-empty mesh"
    );
}

/// `detect_rtc_offset_from_first_element` must now see the building's raw
/// UTM-scale vertex (~500 000 / ~5 400 000) via the same fixed job-eligible
/// entity set and report a large offset instead of `(0, 0, 0)`.
#[test]
fn building_only_geometry_rtc_offset_is_no_longer_zero() {
    let content = read_fixture();
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let offset = router.detect_rtc_offset_from_first_element(&content, &mut decoder);

    assert!(
        offset.0.abs() > 10_000.0 || offset.1.abs() > 10_000.0,
        "expected a large RTC offset once the building's geometry is sampled, got {offset:?}"
    );
}

/// After RTC is applied, the building's mesh vertices must be small (close
/// to origin) rather than raw UTM-scale — this is what actually fixes the
/// f32 precision collapse described in the issue.
#[test]
fn building_only_geometry_is_small_after_rtc_is_applied() {
    let content = read_fixture();
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let mut router = GeometryRouter::with_units(&content, &mut decoder);

    let offset = router.detect_rtc_offset_from_first_element(&content, &mut decoder);
    router.set_rtc_offset(offset);

    let entity = decoder.decode_by_id(40).expect("IFCBUILDING #40 must decode");
    let mesh = router
        .process_element(&entity, &mut decoder)
        .expect("building shell geometry should mesh");

    assert!(!mesh.positions.is_empty(), "expected non-empty mesh positions");
    for chunk in mesh.positions.chunks_exact(3) {
        assert!(
            chunk[0].abs() < 10_000.0 && chunk[1].abs() < 10_000.0 && chunk[2].abs() < 10_000.0,
            "vertex ({}, {}, {}) still has large coordinates after RTC",
            chunk[0],
            chunk[1],
            chunk[2]
        );
    }
}
