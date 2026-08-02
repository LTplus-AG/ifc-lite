// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test proving this PR's generalisation over the upstream fix
//! for issue #1910.
//!
//! #1910 was fixed on `main` by unconditionally exempting `IfcBuilding` from
//! `is_non_geometric_spatial` (so `has_geometry_by_name("IFCBUILDING")` is
//! now always `true`). That fix is class-scoped: a DGM/terrain export that
//! instead hangs its geometry off `IfcBuildingStorey` (or any other
//! representationless spatial container) still renders nothing on `main`,
//! because `IfcBuildingStorey` stays in the blocked set — no exporter had
//! been observed giving it a body at the time.
//!
//! This PR's `is_representationless_spatial_container_by_name` +
//! `nth_attribute_is_present` instance-level check generalises past the
//! single class: ANY spatial container that `has_geometry_by_name` blocks by
//! name is let through when THIS instance's `Representation` attribute is
//! exceptionally non-null. This test locks that generalisation with
//! `IfcBuildingStorey` — deliberately NOT `IfcBuilding`, which is already
//! covered class-wide and would not distinguish this PR's contribution from
//! the merged one-liner.

use ifc_lite_core::{build_entity_index, has_geometry_by_name, EntityDecoder, EntityScanner};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/issue_1910_storey_shell_geometry.ifc"
);

fn read_fixture() -> String {
    std::fs::read_to_string(FIXTURE).expect("issue_1910 storey fixture must be present")
}

/// Sanity: unlike `IfcBuilding` (exempted class-wide on `main` by #1969),
/// `IfcBuildingStorey` must still be blocked by name — otherwise this test
/// would not actually be exercising the instance-level exception at all.
#[test]
fn storey_is_still_blocked_by_name_unlike_building() {
    assert!(
        !has_geometry_by_name("IFCBUILDINGSTOREY"),
        "sanity: IFCBUILDINGSTOREY must stay excluded from has_geometry_by_name — \
         if this ever flips true (e.g. a future class-wide exemption), this test \
         stops proving the instance-level generalisation and should be revisited"
    );
    assert!(
        ifc_lite_core::is_representationless_spatial_container_by_name("IFCBUILDINGSTOREY"),
        "sanity: IFCBUILDINGSTOREY must be recognised as a normally-representationless \
         spatial container"
    );
}

/// End-to-end: the production job-collection scan must schedule the storey
/// for meshing (via the instance-level exception, not by-name) and meshing
/// it must produce actual triangles — exactly the class of bug #1910
/// reported, but for a container `main`'s fix does not cover.
#[test]
fn storey_only_geometry_is_scheduled_and_meshes() {
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

    // #40 is the IFCBUILDINGSTOREY entity carrying the IfcShellBasedSurfaceModel.
    // It can ONLY be scheduled via the instance-level exception --
    // has_geometry_by_name("IFCBUILDINGSTOREY") is false (asserted above), so
    // reaching this job at all proves the exception fired.
    assert!(
        scheduled_ids.contains(&40),
        "expected IFCBUILDINGSTOREY #40 to be scheduled for meshing via the \
         instance-level exception, got {scheduled_ids:?}"
    );
    assert!(
        !has_geometry_by_name("IFCBUILDINGSTOREY"),
        "#40 must have been scheduled by the exception, not by-name"
    );

    let entity = decoder.decode_by_id(40).expect("IFCBUILDINGSTOREY #40 must decode");
    let mesh = router
        .process_element(&entity, &mut decoder)
        .expect("storey shell geometry should mesh");
    assert!(
        !mesh.positions.is_empty() && !mesh.indices.is_empty(),
        "expected the storey's shell geometry to produce a non-empty mesh"
    );

    // #15 is the sibling IFCBUILDING with a null Representation. Since #1969
    // exempted IfcBuilding class-wide, it IS scheduled as a job (by name, not
    // by the exception) -- but with no ProductDefinitionShape it must produce
    // no mesh, confirming "the gate only permits meshing" still holds for it.
    let building = decoder.decode_by_id(15).expect("IFCBUILDING #15 must decode");
    let building_mesh = router.process_element(&building, &mut decoder);
    let building_produced_geometry = building_mesh
        .as_ref()
        .is_ok_and(|m| !m.positions.is_empty());
    assert!(
        !building_produced_geometry,
        "the representationless IFCBUILDING #15 must not produce real geometry"
    );
}


/// Finding-2 coverage: `detect_rtc_offset_from_first_element`'s
/// `is_exceptional_spatial_container` / `has_geometry_by_name` interaction
/// (`rust/geometry/src/router/rtc_offset.rs:412-414`). The building fixture
/// alone no longer exercises this — `has_geometry_by_name("IFCBUILDING")` is
/// `true` post-#1969, so the `!has_geometry_by_name(type_name)` half of the
/// `if` is already `false` and `is_exceptional_spatial_container` is never
/// consulted for it. `IfcBuildingStorey` stays name-blocked, so RTC sampling
/// this fixture can ONLY see the storey's raw UTM-scale vertex through the
/// exceptional branch actually firing.
#[test]
fn storey_only_geometry_rtc_offset_is_no_longer_zero() {
    let content = read_fixture();
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let offset = router.detect_rtc_offset_from_first_element(&content, &mut decoder);

    assert!(
        offset.0.abs() > 10_000.0 || offset.1.abs() > 10_000.0,
        "expected a large RTC offset once the storey's exceptional geometry is \
         sampled, got {offset:?}"
    );
}

/// Direct truth-table coverage of the two predicates `detect_rtc_offset_from_first_element`
/// combines at line 412-414, independent of any fixture: confirms the
/// interaction is neither "both must be true" nor "either alone suffices" in
/// the wrong direction for the representative cases this PR cares about.
#[test]
fn has_geometry_and_exceptional_container_predicates_combine_as_expected() {
    // Ordinary geometric element: covered by has_geometry_by_name alone: the
    // exceptional-container predicate is irrelevant (and false) for it.
    assert!(has_geometry_by_name("IFCWALL"));
    assert!(!ifc_lite_core::is_representationless_spatial_container_by_name(
        "IFCWALL"
    ));

    // IfcBuilding: covered by has_geometry_by_name alone as of #1969 --
    // the exceptional-container predicate is now false for it too, so RTC
    // sampling reaches it via the FIRST half of the `if`, not the second.
    assert!(has_geometry_by_name("IFCBUILDING"));
    assert!(!ifc_lite_core::is_representationless_spatial_container_by_name(
        "IFCBUILDING"
    ));

    // IfcBuildingStorey: the case this PR's exception exists for. Blocked by
    // name, so RTC sampling reaches it ONLY when the exceptional-container
    // predicate is true AND the instance carries a real Representation.
    assert!(!has_geometry_by_name("IFCBUILDINGSTOREY"));
    assert!(ifc_lite_core::is_representationless_spatial_container_by_name(
        "IFCBUILDINGSTOREY"
    ));

    // A non-spatial, non-geometric abstract type: neither predicate should
    // let it through.
    assert!(!has_geometry_by_name("IFCPROJECT"));
    assert!(!ifc_lite_core::is_representationless_spatial_container_by_name(
        "IFCPROJECT"
    ));
}
