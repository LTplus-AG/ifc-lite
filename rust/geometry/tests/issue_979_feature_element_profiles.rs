// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #979 (construction projection) follow-up: feature elements must not
//! emit construction-projection profiles.
//!
//! `IfcOpeningElement` (and the rest of the `IfcFeatureElement` family) are
//! boolean subtraction/addition operands, not building structure. They have
//! `IfcExtrudedAreaSolid` `Body` representations, so before the fix
//! `extract_profiles` happily pulled their void cross-sections in and the 2D
//! floor-plan projection drew spurious rectangles inside walls. AC20-FZK-Haus
//! carries 17 `IFCOPENINGELEMENT` entities — a good regression fixture.

use ifc_lite_geometry::extract_profiles;
use std::path::PathBuf;

fn fixture(rel: &str) -> Option<String> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(rel);
    std::fs::read_to_string(p).ok()
}

#[test]
fn ac20_extracts_no_feature_element_profiles() {
    let Some(content) = fixture("tests/models/ara3d/AC20-FZK-Haus.ifc") else {
        eprintln!("AC20-FZK-Haus.ifc fixture missing — skipping");
        return;
    };

    // Sanity-check the fixture still contains the openings the test guards
    // against, so a future fixture swap can't silently make this test vacuous.
    let opening_count = content.matches("IFCOPENINGELEMENT(").count();
    assert!(
        opening_count > 0,
        "fixture should contain IfcOpeningElement entities (found {opening_count})"
    );

    let profiles = extract_profiles(&content, 0);

    // No profile should belong to a feature/void element type.
    let feature_profiles: Vec<&str> = profiles
        .iter()
        .map(|p| p.ifc_type.as_str())
        .filter(|t| {
            t.eq_ignore_ascii_case("IfcOpeningElement")
                || t.eq_ignore_ascii_case("IfcOpeningStandardCase")
                || t.eq_ignore_ascii_case("IfcVoidingFeature")
                || t.eq_ignore_ascii_case("IfcFeatureElementSubtraction")
                || t.eq_ignore_ascii_case("IfcProjectionElement")
                || t.eq_ignore_ascii_case("IfcSurfaceFeature")
        })
        .collect();
    assert!(
        feature_profiles.is_empty(),
        "feature/void elements must not produce projection profiles, got: {feature_profiles:?}"
    );

    // The fix must not have nuked real structure: AC20 is full of extruded
    // walls/slabs/columns, so extraction must still yield structural profiles.
    // Match by substring (case-insensitive) rather than an exact type string —
    // FZK-Haus walls are `IfcWallStandardCase`, not `IfcWall`.
    let types: Vec<&str> = profiles.iter().map(|p| p.ifc_type.as_str()).collect();
    assert!(
        !profiles.is_empty(),
        "feature-element exclusion must not nuke real structure; AC20 should still yield profiles"
    );
    let structural = profiles.iter().filter(|p| {
        let t = p.ifc_type.to_ascii_lowercase();
        t.contains("wall") || t.contains("slab") || t.contains("column") || t.contains("beam")
    }).count();
    assert!(
        structural > 0,
        "common structural elements (wall/slab/column/beam) should still produce profiles; got: {types:?}"
    );
}

/// #3172: the #979 filter read `entity.ifc_type`, which the decoder fills with
/// a bare `IfcType::from_str`. Every LEGACY keyword therefore arrived as
/// `Unknown`, and `Unknown` is a subtype of nothing — so the filter that
/// exists to keep void cross-sections out of the floor plan let every legacy
/// spelling of a feature element straight through.
///
/// `IFCOPENINGSTANDARDCASE` is that spelling for an opening: it is in
/// `legacy_entities.rs`, so `has_geometry_by_name` admits it to this loop, and
/// it was then never recognised as a feature element. The fixture is AC20 with
/// its 17 openings respelled — same geometry, same placements, one keyword
/// changed — so the only thing that can move the profile count is the filter.
#[test]
fn legacy_opening_spellings_emit_no_profiles_either() {
    let Some(content) = fixture("tests/models/ara3d/AC20-FZK-Haus.ifc") else {
        eprintln!("AC20-FZK-Haus.ifc fixture missing — skipping");
        return;
    };
    let openings = content.matches("IFCOPENINGELEMENT(").count();
    assert!(openings > 0, "fixture lost its openings — the respelling below would test nothing");

    let respelled = content.replace("IFCOPENINGELEMENT(", "IFCOPENINGSTANDARDCASE(");
    assert_eq!(
        respelled.matches("IFCOPENINGSTANDARDCASE(").count(),
        openings,
        "the respelling must move every opening, or the count below is diluted"
    );

    let baseline = extract_profiles(&content, 0);
    let legacy = extract_profiles(&respelled, 0);

    // The respelled file must produce the SAME profiles as the original. A
    // count assertion alone would pass if the filter dropped 17 real walls and
    // admitted 17 openings, so the types are compared as a multiset.
    let mut want: Vec<&str> = baseline.iter().map(|p| p.ifc_type.as_str()).collect();
    let mut got: Vec<&str> = legacy.iter().map(|p| p.ifc_type.as_str()).collect();
    want.sort_unstable();
    got.sort_unstable();
    assert_eq!(
        got, want,
        "respelling IFCOPENINGELEMENT as IFCOPENINGSTANDARDCASE changed the extracted profiles"
    );

    // And the baseline must be non-empty, or "they match" is a statement about
    // two empty vectors.
    assert!(!baseline.is_empty(), "AC20 must yield structural profiles");
}
