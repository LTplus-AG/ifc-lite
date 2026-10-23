// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The 2D drawing extractor walks the representations the mesh path renders
//! (`Select::Meshed`) and bounds mapped nesting the way the mesh path does
//! (`MAX_MAPPED_ITEM_DEPTH` plus the path-scoped visited set), through the one
//! `RepresentationWalk` (C2-X1, D36). Before, it selected on the
//! RepresentationIdentifier (`Body`/`SweptSolid`) and capped mapped chains at a
//! private depth of 3 with no visited set, so a drawing and the 3D model
//! disagreed about which solids exist.

use ifc_lite_core::MAX_MAPPED_ITEM_DEPTH;
use ifc_lite_geometry::extract_profiles_with_diagnostics;

#[path = "support/profile_walk_model.rs"]
mod model;
use model::{chain, mapped, wall, TARGET};

/// An element whose body is carried both directly and as a mapped duplicate
/// renders once on the mesh path (the #4699 mapped-duplicate exclusion), so the
/// drawing draws it once. The identifier filter drew both.
#[test]
fn mapped_duplicate_of_direct_body_draws_once() {
    let entities = format!(
        "{TARGET}\n#150=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140));\n\
         #160=IFCSHAPEREPRESENTATION(#13,'Body','MappedRepresentation',(#1000));\n{}",
        mapped(1000, "#140")
    );
    let (profiles, skipped) = extract_profiles_with_diagnostics(&wall("#150,#160", &entities), 0);
    assert_eq!(profiles.len(), 1, "the mapped duplicate must not draw a second profile: {profiles:?}");
    assert!(skipped.is_empty(), "{skipped:?}");

    // Control: the mapped representation alone (no direct body) still draws.
    let (alone, _) = extract_profiles_with_diagnostics(&wall("#160", &entities), 0);
    assert_eq!(alone.len(), 1, "a mapped-only body must draw");
}

/// The mesh path follows mapped chains to `MAX_MAPPED_ITEM_DEPTH` levels; the
/// extractor's private cap of 3 dropped a 5-level chain (nesting index 4) that
/// renders in 3D.
#[test]
fn mapped_chain_deeper_than_the_old_cap_draws() {
    let (profiles, skipped) = extract_profiles_with_diagnostics(&chain(5), 0);
    assert_eq!(profiles.len(), 1, "a 5-level mapped chain renders, so it draws: {skipped:?}");
    assert!(skipped.is_empty(), "{skipped:?}");

    let (at_cap, skipped) = extract_profiles_with_diagnostics(&chain(MAX_MAPPED_ITEM_DEPTH), 0);
    assert_eq!(at_cap.len(), 1, "a chain at the shared cap draws: {skipped:?}");
    assert!(skipped.is_empty(), "{skipped:?}");
}

/// Past the shared cap the chain is refused and the drop is recorded once.
#[test]
fn mapped_chain_past_the_cap_is_refused_and_recorded() {
    let (profiles, skipped) = extract_profiles_with_diagnostics(&chain(MAX_MAPPED_ITEM_DEPTH + 1), 0);
    assert!(profiles.is_empty(), "{profiles:?}");
    assert_eq!(skipped.len(), 1, "one refusal, one record: {skipped:?}");
    assert_eq!(skipped[0].express_id, 100);
    assert!(skipped[0].reason.contains("maximum depth"), "{skipped:?}");
}

/// A map whose representation holds an extrusion AND a mapped item back into
/// the same map is a cycle. The walk refuses it at the first repeat and records
/// it; the old depth cap instead re-drew the extrusion once per level (4x)
/// before giving up.
#[test]
fn mapped_cycle_is_refused_and_recorded() {
    // #1000's own mapped representation holds #1000 again.
    let entities = format!(
        "{TARGET}\n#160=IFCSHAPEREPRESENTATION(#13,'Body','MappedRepresentation',(#1000));\n{}",
        mapped(1000, "#240,#1000")
    );
    let (profiles, skipped) = extract_profiles_with_diagnostics(&wall("#160", &entities), 0);
    assert_eq!(profiles.len(), 1, "the extrusion inside the cycle draws exactly once: {profiles:?}");
    assert_eq!(skipped.len(), 1, "the cycle is recorded once: {skipped:?}");
    assert_eq!(skipped[0].express_id, 100);
    assert!(skipped[0].reason.contains("cyclic"), "the record names the cycle: {skipped:?}");
}

/// The mesh path selects on the effective RepresentationType, so a solid
/// filed under any identifier renders; the identifier filter dropped it.
#[test]
fn representations_meshed_under_other_identifiers_draw() {
    for rep in [
        "#150=IFCSHAPEREPRESENTATION(#13,'Model','SweptSolid',(#140));",
        "#150=IFCSHAPEREPRESENTATION(#13,$,'SweptSolid',(#140));",
        "#150=IFCSHAPEREPRESENTATION(#13,'Body','',(#140));",
    ] {
        let (profiles, skipped) = extract_profiles_with_diagnostics(&wall("#150", rep), 0);
        assert_eq!(profiles.len(), 1, "{rep} renders, so it draws: {skipped:?}");
        assert!(skipped.is_empty(), "{skipped:?}");
    }
}

/// And the converse: a representation the mesh path does not render (a
/// footprint) is not drawn, whatever its identifier says.
#[test]
fn representations_the_mesh_path_skips_are_not_drawn() {
    let rep = "#150=IFCSHAPEREPRESENTATION(#13,'Body','Curve2D',(#140));";
    let (profiles, skipped) = extract_profiles_with_diagnostics(&wall("#150", rep), 0);
    assert!(profiles.is_empty(), "{profiles:?}");
    assert!(skipped.is_empty(), "a deliberate exclusion is not a drop: {skipped:?}");
}
