// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for [`super::schema_helpers`]. Split out of `schema_helpers.rs` to
//! keep that module under the 400-line rule (AGENTS.md), matching the
//! `stream_meta.rs` / `stream_meta_tests.rs` pattern.

use super::*;

#[test]
fn building_elements_have_geometry() {
    for name in [
        "IFCWALL",
        "IFCSLAB",
        "IFCBEAM",
        "IFCCOLUMN",
        "IFCDOOR",
        "IFCWINDOW",
        "IFCROOF",
        "IFCSTAIR",
        "IFCSHADINGDEVICE",
    ] {
        assert!(has_geometry_by_name(name), "{name} should have geometry");
    }
}

#[test]
fn mep_elements_have_geometry() {
    for name in [
        "IFCFLOWSEGMENT",
        "IFCFLOWFITTING",
        "IFCENERGYCONVERSIONDEVICE",
        "IFCFLOWTREATMENTDEVICE",
        "IFCBOILER",
        "IFCPUMP",
        "IFCVALVE",
    ] {
        assert!(has_geometry_by_name(name), "{name} should have geometry");
    }
}

/// Regression for PR #585 — IfcSolarDevice was missing because the
/// whitelist matched leaf names directly even though its parent
/// `IfcEnergyConversionDevice` was already in the list.
#[test]
fn solar_device_has_geometry() {
    assert!(has_geometry_by_name("IFCSOLARDEVICE"));
    assert!(has_geometry_by_name("IfcSolarDevice"));
}

#[test]
fn ifc4x3_infrastructure_have_geometry() {
    for name in [
        "IFCBEARING",
        "IFCKERB",
        "IFCPAVEMENT",
        "IFCRAIL",
        "IFCTRACKELEMENT",
        "IFCSIGN",
        "IFCSIGNAL",
        "IFCEARTHWORKSCUT",
    ] {
        assert!(has_geometry_by_name(name), "{name} should have geometry");
    }
}

#[test]
fn reinforcement_variants_have_geometry() {
    assert!(has_geometry_by_name("IFCREINFORCINGBAR"));
    assert!(has_geometry_by_name("IFCREINFORCINGMESH"));
    assert!(has_geometry_by_name("IFCREINFORCEDSOIL"));
}

#[test]
fn standardcase_and_elementedcase_have_geometry() {
    for name in [
        "IFCBEAMSTANDARDCASE",
        "IFCSLABSTANDARDCASE",
        "IFCSLABELEMENTEDCASE",
        "IFCWALLSTANDARDCASE",
        "IFCWALLELEMENTEDCASE",
        "IFCDOORSTANDARDCASE",
        "IFCWINDOWSTANDARDCASE",
        "IFCOPENINGSTANDARDCASE",
    ] {
        assert!(has_geometry_by_name(name), "{name} should have geometry");
    }
}

#[test]
fn space_and_site_have_geometry() {
    assert!(has_geometry_by_name("IFCSPACE"));
    assert!(has_geometry_by_name("IFCSITE"));
    assert!(has_geometry_by_name("IFCOPENINGELEMENT"));
    // #1075: IfcSpatialZone may carry a body (Revit Family/Dynamo GFA
    // volumes) — it is meshed like IfcSpace when a representation exists.
    assert!(has_geometry_by_name("IFCSPATIALZONE"));
}

/// #1910: terrain/DGM exporters attach an IfcShellBasedSurfaceModel
/// directly to IfcBuilding. Blocking the class meant the entity never
/// became a geometry job, so the model rendered nothing at all.
#[test]
fn building_bears_geometry() {
    assert!(has_geometry_by_name("IFCBUILDING"));
    assert!(has_geometry_by_name("IfcBuilding"));
    // Its siblings under IfcSpatialStructureElement stay blocked — no
    // exporter has been observed giving them a body.
    assert!(!has_geometry_by_name("IFCBUILDINGSTOREY"));
    assert!(!has_geometry_by_name("IFCFACILITY"));
}

#[test]
fn legacy_ifc2x3_distribution_names_have_geometry() {
    // Routed through legacy_entities now (was an inline match arm).
    assert!(has_geometry_by_name("IFCEQUIPMENTELEMENT"));
    assert!(has_geometry_by_name("IFCELECTRICALDISTRIBUTIONPOINT"));
}

#[test]
fn non_geometric_spatial_excluded() {
    for name in [
        // The original whitelist excluded these explicitly.
        // IFCBUILDING moved out — see `building_bears_geometry` (#1910).
        "IFCBUILDINGSTOREY",
        "IFCFACILITY",
        "IFCFACILITYPART",
        // Abstract bases — same logic, never rendered directly.
        "IFCSPATIALELEMENT",
        "IFCSPATIALSTRUCTUREELEMENT",
        // IFC4X3 facility subtypes: previously absent from the whitelist
        // and would now leak through if the block-list were leaf-only
        // (regression flagged on the original PR review).
        "IFCBRIDGE",
        "IFCROAD",
        "IFCRAILWAY",
        "IFCMARINEFACILITY",
        "IFCBRIDGEPART",
        "IFCFACILITYPARTCOMMON",
        // External spatial elements are abstract air volumes, not
        // rendered. Not in the original whitelist.
        "IFCEXTERNALSPATIALELEMENT",
        "IFCEXTERNALSPATIALSTRUCTUREELEMENT",
    ] {
        assert!(!has_geometry_by_name(name), "{name} should NOT have geometry");
    }
}

#[test]
fn non_products_excluded() {
    for name in [
        "IFCPROJECT",
        "IFCMATERIAL",
        "IFCPROPERTYSET",
        "IFCRELAGGREGATES",
        "IFCDIMENSIONALEXPONENTS",
        "IFCSURFACESTYLERENDERING",
        "IFCGEOMETRICREPRESENTATIONSUBCONTEXT",
        "IFCCARTESIANPOINT",
    ] {
        assert!(!has_geometry_by_name(name), "{name} should NOT have geometry");
    }
}

#[test]
fn legacy_proxy_and_buildingelement_have_geometry() {
    // From legacy_entities: both map to renderable types
    assert!(has_geometry_by_name("IFCPROXY"));
    assert!(has_geometry_by_name("IFCBUILDINGELEMENT"));
}

#[test]
fn unknown_garbage_excluded() {
    // Reinforcement substring tightened to a prefix — unrelated tokens
    // containing "REINFORC" are no longer accepted.
    assert!(!has_geometry_by_name("IFCNOTAREALTYPE"));
    assert!(!has_geometry_by_name(""));
    assert!(!has_geometry_by_name("FOOREINFORCEDBAR"));
}

#[test]
fn cached_results_are_consistent() {
    // Hit the cache twice for the same name and confirm both return the
    // same value (regression for any race in the cache layer).
    for _ in 0..3 {
        assert!(has_geometry_by_name("IFCWALL"));
        assert!(!has_geometry_by_name("IFCPROJECT"));
        assert!(is_simple_geometry_type("IFCWALL"));
        assert!(!is_simple_geometry_type("IFCWINDOW"));
    }
}

#[test]
fn is_simple_geometry_type_routes_correctly() {
    // Structural / structural-adjacent: simple.
    assert!(is_simple_geometry_type("IFCWALL"));
    assert!(is_simple_geometry_type("IFCSLAB"));
    assert!(is_simple_geometry_type("IFCBEAM"));
    assert!(is_simple_geometry_type("IFCCOLUMN"));

    // Secondary categories.
    assert!(!is_simple_geometry_type("IFCWINDOW"));
    assert!(!is_simple_geometry_type("IFCDOOR"));
    assert!(!is_simple_geometry_type("IFCOPENINGELEMENT"));
    assert!(!is_simple_geometry_type("IFCFLOWSEGMENT"));
    assert!(!is_simple_geometry_type("IFCSOLARDEVICE"));
    assert!(!is_simple_geometry_type("IFCSPACE"));
    assert!(!is_simple_geometry_type("IFCANNOTATION"));
    assert!(!is_simple_geometry_type("IFCBUILDINGELEMENTPROXY"));

    // Mixed-case input — exercises the `to_ascii_uppercase` branch.
    assert!(is_simple_geometry_type("IfcWall"));
    assert!(!is_simple_geometry_type("IfcDoor"));
}

// #1910 review follow-up: `nth_attribute_is_present` had no direct unit
// test — every existing reference was production use or an integration
// test exercising it incidentally. These pin the documented contract:
// "attribute at `index` (0-based, top-level — respects nested parens and
// quoted strings) is present and non-null (`$`)".

#[test]
fn nth_attribute_present_and_non_null_is_true() {
    let entity = b"#40=IFCBUILDINGSTOREY('guid',$,'Level 1',$,$,#18,#39,$,.ELEMENT.,0.);";
    // index 0: 'guid' — present, non-null.
    assert!(nth_attribute_is_present(entity, 0));
    // index 6: #39 (Representation) — present, non-null.
    assert!(nth_attribute_is_present(entity, 6));
}

#[test]
fn nth_attribute_dollar_is_false() {
    let entity = b"#40=IFCBUILDINGSTOREY('guid',$,'Level 1',$,$,#18,$,$,.ELEMENT.,0.);";
    // index 6: $ (Representation) — present but null.
    assert!(!nth_attribute_is_present(entity, 6));
    // index 1: $ (OwnerHistory) — same.
    assert!(!nth_attribute_is_present(entity, 1));
}

#[test]
fn nth_attribute_past_the_end_is_false() {
    let entity = b"#1=IFCWALL('guid',$,'Wall');";
    // Only 3 top-level attributes (indices 0..=2); index 10 doesn't exist.
    assert!(!nth_attribute_is_present(entity, 10));
}

#[test]
fn nth_attribute_empty_value_is_false() {
    // `,,` — the middle attribute is an empty token, not `$` and not a
    // value. The scanner treats an empty trimmed token as absent: the
    // `!token.is_empty()` check in `nth_attribute_is_present` fails.
    let entity = b"#1=IFCFOO('a',,'c');";
    assert!(!nth_attribute_is_present(entity, 1));
    // Confirm the neighbours parsed correctly around the empty slot.
    assert!(nth_attribute_is_present(entity, 0));
    assert!(nth_attribute_is_present(entity, 2));
}

#[test]
fn nth_attribute_nested_parens_are_not_top_level_commas() {
    // IFCPOLYLOOP((#20,#21,#22)) — the whole nested list is attribute 0;
    // the commas inside the inner parens must not be counted as top-level
    // separators, and there must be no attribute 1.
    let entity = b"#30=IFCPOLYLOOP((#20,#21,#22),$);";
    assert!(nth_attribute_is_present(entity, 0));
    assert!(!nth_attribute_is_present(entity, 1));
    assert!(!nth_attribute_is_present(entity, 2));
}

#[test]
fn nth_attribute_quoted_comma_and_paren_are_not_top_level() {
    // A quoted string containing both a comma and parens must not be
    // split on, nor have its parens counted toward nesting depth.
    let entity =
        b"#40=IFCBUILDINGSTOREY('guid',$,'Level 1, west (annex)',$);";
    assert!(nth_attribute_is_present(entity, 0)); // 'guid'
    assert!(!nth_attribute_is_present(entity, 1)); // $
    assert!(nth_attribute_is_present(entity, 2)); // the quoted string itself
    assert!(!nth_attribute_is_present(entity, 3)); // $
    // Nothing beyond attribute 3 — the embedded comma/parens didn't
    // fabricate extra attributes.
    assert!(!nth_attribute_is_present(entity, 4));
}

#[test]
fn nth_attribute_escaped_quote_stays_inside_the_string() {
    // STEP escapes an embedded `'` as `''`. The scanner must not treat
    // the escape as the string's closing quote.
    let entity = b"#1=IFCWALL('guid',$,'quo''te',$);";
    assert!(nth_attribute_is_present(entity, 2)); // 'quo''te'
    assert!(!nth_attribute_is_present(entity, 3)); // $
    // No phantom attribute 4 from mis-parsing the escape as a delimiter.
    assert!(!nth_attribute_is_present(entity, 4));
}

#[test]
fn nth_attribute_no_open_paren_is_false() {
    assert!(!nth_attribute_is_present(b"#1=IFCWALL;", 0));
}

#[test]
fn nth_attribute_no_close_paren_is_false() {
    assert!(!nth_attribute_is_present(b"#1=IFCWALL('guid'", 0));
}

#[test]
fn nth_attribute_reversed_boundary_is_false() {
    // `)` appears before `(` — must not panic or index out of bounds.
    assert!(!nth_attribute_is_present(b")(", 0));
    assert!(!nth_attribute_is_present(b"garbage)stuff(more", 0));
}
