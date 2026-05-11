// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Hand-maintained schema helpers built on top of the auto-generated
//! `IfcType` enum.
//!
//! These helpers used to live appended to `generated/schema.rs` despite that
//! file's "DO NOT EDIT" header. Moving them here keeps them safe from a
//! re-run of `@ifc-lite/codegen` and lets us derive answers from the EXPRESS
//! inheritance graph instead of maintaining a leaf-level allow-list that has
//! to be amended every time a new IFC4X3 subtype shows up (see PR #585 for
//! `IfcSolarDevice`, which inherits from `IfcEnergyConversionDevice` and was
//! therefore already covered conceptually by the old whitelist's parent
//! entry, but missed in practice because the whitelist was only checked by
//! string match).
//!
//! Co-authored with Geronimo <gerald.stampfel+geronimo@gmail.com> (PR #585).
//!
//! Both helpers are on the hot path during scene construction, where the
//! same ~50–100 distinct type names are queried thousands of times per file.
//! We memoise per-name behind a `RwLock<FxHashMap<String, bool>>`: the first
//! call for a name pays the full `IfcType::from_str` (a ~1300-arm match) +
//! `is_subtype_of` traversal cost; subsequent calls take a read-lock and a
//! single hash lookup.

use std::sync::{OnceLock, RwLock};

use rustc_hash::FxHashMap;

use crate::generated::IfcType;
use crate::legacy_entities::get_legacy_entity_info;

/// Normalise to uppercase ASCII without allocating when the input is already
/// uppercase (the common case — STEP type tokens are emitted uppercase).
fn normalise_uppercase(type_name: &str) -> std::borrow::Cow<'_, str> {
    if type_name.bytes().any(|b| b.is_ascii_lowercase()) {
        std::borrow::Cow::Owned(type_name.to_ascii_uppercase())
    } else {
        std::borrow::Cow::Borrowed(type_name)
    }
}

/// Look up a cached bool, or compute via `f` and insert.
fn cached<F>(cache: &RwLock<FxHashMap<String, bool>>, key: &str, f: F) -> bool
where
    F: FnOnce() -> bool,
{
    if let Ok(read) = cache.read() {
        if let Some(&v) = read.get(key) {
            return v;
        }
    }
    let value = f();
    if let Ok(mut write) = cache.write() {
        write.insert(key.to_owned(), value);
    }
    value
}

/// Check if a type name (UPPERCASE STEP string) represents an `IfcProduct`
/// subtype that can bear geometry (has `ObjectPlacement` + `Representation`).
///
/// Implementation:
/// 1. Modern names go through `IfcType::from_str` and are accepted iff they
///    inherit from `IfcProduct`, with a small block-list for abstract spatial
///    containers (`IfcBuilding`, `IfcBuildingStorey`, `IfcFacility`,
///    `IfcFacilityPart`, `IfcSpatialElement`, `IfcSpatialStructureElement`)
///    that don't carry geometry directly. `IfcSpace` and `IfcSite` (and any
///    concrete subtype of either) are intentionally kept — they have boundary
///    representations the renderer consumes.
/// 2. Legacy IFC2x3 / removed-in-IFC4x3 names that aren't in the generated
///    enum (e.g. `IFCSLABELEMENTEDCASE`, `IFCBUILDINGELEMENT`, `IFCPROXY`,
///    `IFCEQUIPMENTELEMENT`, `IFCELECTRICALDISTRIBUTIONPOINT`) resolve through
///    `legacy_entities::get_legacy_entity_info`, which carries a
///    `has_geometry` flag.
/// 3. Reinforcement variants not covered above fall back to a substring
///    match (`REINFORCING…` / `REINFORCED…`).
pub fn has_geometry_by_name(type_name: &str) -> bool {
    static CACHE: OnceLock<RwLock<FxHashMap<String, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(FxHashMap::default()));

    let upper = normalise_uppercase(type_name);
    cached(cache, upper.as_ref(), || compute_has_geometry(upper.as_ref()))
}

fn compute_has_geometry(upper: &str) -> bool {
    if let Some(info) = get_legacy_entity_info(upper) {
        return info.has_geometry;
    }

    let t = IfcType::from_str(upper);
    if matches!(t, IfcType::Unknown(_)) {
        // Reinforcement bars/meshes/elements are common in IFC2x3 files. Match
        // a tighter prefix than `contains("REINFORC")` to avoid catching
        // unrelated tokens with the substring.
        return upper.starts_with("IFCREINFORCING") || upper.starts_with("IFCREINFORCED");
    }

    if !t.is_subtype_of(IfcType::IfcProduct) {
        return false;
    }

    !is_non_geometric_spatial(t)
}

/// Subtypes of `IfcProduct` that exist solely as spatial containers and
/// aren't rendered directly. `IfcSpace`/`IfcSite` and their concrete
/// subtypes are deliberately exempt — their boundary representations are
/// consumed by the renderer.
///
/// We block by inheritance, not by exact match, so IFC4X3 facility
/// subclasses like `IfcBridge`/`IfcRoad`/`IfcRailway`/`IfcMarineFacility`
/// (under `IfcFacility`), their `*Part` variants (under `IfcFacilityPart`),
/// `IfcSpatialZone`, and any future concrete spatial container all collapse
/// to the same answer without the whitelist needing to enumerate them.
fn is_non_geometric_spatial(t: IfcType) -> bool {
    if t.is_subtype_of(IfcType::IfcSpace) || t.is_subtype_of(IfcType::IfcSite) {
        return false;
    }
    t.is_subtype_of(IfcType::IfcSpatialElement)
}

/// Check if an IFC entity class is "simple" geometry (processed first for
/// fast first frame). Driven off the EXPRESS inheritance graph rather than
/// a leaf-level blacklist, so new IFC4X3 subtypes (e.g. `IfcSolarDevice`
/// under `IfcEnergyConversionDevice`) are categorised correctly without
/// code changes — see PR #585.
///
/// Returns `true` for "simple" elements (load first), `false` for
/// "secondary/complex" (openings, doors, windows, furniture, MEP/distribution
/// elements, spaces, sites, annotations, virtual/proxy entities).
pub fn is_simple_geometry_type(type_name: &str) -> bool {
    static CACHE: OnceLock<RwLock<FxHashMap<String, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(FxHashMap::default()));

    let upper = normalise_uppercase(type_name);
    cached(cache, upper.as_ref(), || compute_is_simple(upper.as_ref()))
}

fn compute_is_simple(upper: &str) -> bool {
    let t = match get_legacy_entity_info(upper) {
        Some(info) => info.base_type,
        None => IfcType::from_str(upper),
    };

    // Anything not in the modern schema defaults to "simple" priority,
    // matching the original blacklist's "anything else is simple" behaviour.
    if matches!(t, IfcType::Unknown(_)) {
        return true;
    }

    let is_secondary = t.is_subtype_of(IfcType::IfcOpeningElement)
        || t.is_subtype_of(IfcType::IfcWindow)
        || t.is_subtype_of(IfcType::IfcDoor)
        || t.is_subtype_of(IfcType::IfcFurnishingElement)
        // Covers IfcEnergyConversionDevice + IfcSolarDevice + every Flow*
        // and every MEP terminal — all inherit from IfcDistributionElement.
        || t.is_subtype_of(IfcType::IfcDistributionElement)
        || matches!(
            t,
            // Spatial elements that have geometry but aren't structural.
            IfcType::IfcSpace
                | IfcType::IfcSite
                // Annotations / virtual / proxy.
                | IfcType::IfcAnnotation
                | IfcType::IfcVirtualElement
                | IfcType::IfcBuildingElementProxy
        );

    !is_secondary
}

#[cfg(test)]
mod tests {
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
            "IFCBUILDING",
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
            // IfcSpatialZone — concrete but a container, not a renderable
            // body. The original whitelist did not include it.
            "IFCSPATIALZONE",
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
}
