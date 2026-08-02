// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for [`super::schema_helpers`]. Split out of `schema_helpers.rs` to
//! keep that module under the 400-line rule (AGENTS.md), matching the
//! `stream_meta.rs` / `stream_meta_tests.rs` pattern.

use super::*;

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
