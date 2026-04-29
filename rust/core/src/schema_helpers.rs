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

use crate::generated::IfcType;
use crate::legacy_entities::get_legacy_entity_info;

/// Check if a type name (UPPERCASE STEP string) represents an `IfcProduct`
/// subtype that can bear geometry (has `ObjectPlacement` + `Representation`).
///
/// Implementation:
/// 1. Modern names go through `IfcType::from_str` and are accepted iff they
///    inherit from `IfcProduct`, with a small block-list for abstract spatial
///    containers (`IfcBuilding`, `IfcBuildingStorey`, `IfcFacility`,
///    `IfcFacilityPart`, `IfcSpatialElement`, `IfcSpatialStructureElement`)
///    that don't carry geometry directly. `IfcSpace` and `IfcSite` are
///    intentionally kept — they have boundary representations the renderer
///    consumes.
/// 2. Legacy IFC2x3 / removed-in-IFC4x3 names that aren't in the generated
///    enum (e.g. `IFCSLABELEMENTEDCASE`, `IFCBUILDINGELEMENT`, `IFCPROXY`)
///    are resolved through `legacy_entities::get_legacy_entity_info`, which
///    already carries a `has_geometry` flag.
/// 3. Reinforcement variants and a couple of legacy names not covered above
///    fall back to a substring/exact match.
pub fn has_geometry_by_name(type_name: &str) -> bool {
    // Avoid an allocation when the input is already uppercase ASCII.
    let upper_owned;
    let upper: &str = if type_name.bytes().any(|b| b.is_ascii_lowercase()) {
        upper_owned = type_name.to_ascii_uppercase();
        upper_owned.as_str()
    } else {
        type_name
    };

    // Legacy / removed entity names not present in the modern enum carry an
    // explicit `has_geometry` flag in the legacy registry.
    if let Some(info) = get_legacy_entity_info(upper) {
        return info.has_geometry;
    }

    let t = IfcType::from_str(upper);
    if matches!(t, IfcType::Unknown(_)) {
        // Reinforcement bars/meshes and a couple of IFC2x3 names not in the
        // legacy registry. Keep this list minimal — anything new should land
        // in `legacy_entities.rs` instead.
        return upper.contains("REINFORC")
            || matches!(upper, "IFCEQUIPMENTELEMENT" | "IFCELECTRICALDISTRIBUTIONPOINT");
    }

    if !t.is_subtype_of(IfcType::IfcProduct) {
        return false;
    }

    !is_non_geometric_spatial(t)
}

/// Subtypes of `IfcProduct` that exist solely as spatial containers and
/// aren't rendered directly. `IfcSpace` and `IfcSite` are deliberately NOT
/// in this set.
fn is_non_geometric_spatial(t: IfcType) -> bool {
    matches!(
        t,
        IfcType::IfcSpatialElement
            | IfcType::IfcSpatialStructureElement
            | IfcType::IfcBuilding
            | IfcType::IfcBuildingStorey
            | IfcType::IfcFacility
            | IfcType::IfcFacilityPart
    )
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
        // Substring match for unknown reinforcement variants
        assert!(has_geometry_by_name("IFCREINFORCEDOBSCURE"));
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
    fn non_geometric_spatial_excluded() {
        for name in ["IFCBUILDING", "IFCBUILDINGSTOREY", "IFCFACILITY", "IFCFACILITYPART"] {
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
        assert!(!has_geometry_by_name("IFCNOTAREALTYPE"));
        assert!(!has_geometry_by_name(""));
    }
}
