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
