// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Legacy Entity Registry
//!
//! Maps deprecated IFC2x3/IFC4 entities (removed in IFC4x3) to their IFC4x3 equivalents.
//! This allows parsing older IFC files without maintaining full multi-schema support.

use crate::generated::IfcType;

/// Information about a legacy entity
#[derive(Debug, Clone, Copy)]
pub struct LegacyEntityInfo {
    /// The IFC4x3 base type this legacy entity maps to
    pub base_type: IfcType,
    /// Whether this entity typically has geometry
    pub has_geometry: bool,
}

/// Map legacy entity name (uppercase) to its IFC4x3 equivalent
pub fn get_legacy_entity_info(entity_name: &str) -> Option<LegacyEntityInfo> {
    match entity_name {
        // === IFC4 entities removed in IFC4x3 ===

        // Style entities
        "IFCPRESENTATIONSTYLEASSIGNMENT" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcPresentationStyle,
            has_geometry: false,
        }),

        // StandardCase variants (removed, use base type)
        "IFCBEAMSTANDARDCASE" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcBeam,
            has_geometry: true,
        }),
        "IFCCOLUMNSTANDARDCASE" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcColumn,
            has_geometry: true,
        }),
        "IFCMEMBERSTANDARDCASE" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcMember,
            has_geometry: true,
        }),
        "IFCPLATESTANDARDCASE" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcPlate,
            has_geometry: true,
        }),
        "IFCSLABSTANDARDCASE" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcSlab,
            has_geometry: true,
        }),
        "IFCDOORSTANDARDCASE" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcDoor,
            has_geometry: true,
        }),
        "IFCWINDOWSTANDARDCASE" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcWindow,
            has_geometry: true,
        }),
        "IFCOPENINGSTANDARDCASE" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcOpeningElement,
            has_geometry: true,
        }),

        // ElementedCase variants
        "IFCSLABELEMENTEDCASE" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcSlab,
            has_geometry: true,
        }),
        "IFCWALLELEMENTEDCASE" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcWall,
            has_geometry: true,
        }),

        // Style entities (replaced by Type)
        "IFCDOORSTYLE" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcDoorType,
            has_geometry: false,
        }),
        "IFCWINDOWSTYLE" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcWindowType,
            has_geometry: false,
        }),

        // Deprecated generic element
        "IFCPROXY" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcBuildingElementProxy,
            has_geometry: true,
        }),

        // Abstract bases (removed, but rarely used directly)
        "IFCBUILDINGELEMENT" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcBuiltElement,
            has_geometry: true,
        }),
        "IFCBUILDINGELEMENTTYPE" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcBuiltElementType,
            has_geometry: false,
        }),

        // IFC2x3 names that have no IFC4x3 enum variant. They map to the
        // closest modern equivalent; all of them carry geometry.
        //
        // This block is the set `scripts/check-legacy-entity-coverage.mjs`
        // derives: every CONCRETE `IfcProduct` subtype in `@ifc-lite/data`'s
        // IFC2X3/IFC4 tables that `IfcType::from_str` resolves to `Unknown`.
        // Anything missing here is dropped from BOTH the attribute export
        // (`rust/export/src/model.rs` keeps only `is_subtype_of(IfcProduct)`,
        // and `Unknown` is a subtype of nothing) and from meshing
        // (`has_geometry_by_name` refuses `Unknown`) -- silent data loss, not
        // a visible inconsistency (#3172).
        "IFCEQUIPMENTELEMENT" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcDistributionElement,
            has_geometry: true,
        }),
        // Spelled IFCELECTRICALDISTRIBUTIONPOINT until #3172. There is no such
        // IFC2X3 entity -- the real one has no "AL" -- so that arm matched no
        // file that has ever existed. `IfcFlowController` is this entity's own
        // IFC2X3 supertype and is still in IFC4X3, so it is the closest
        // equivalent rather than a guess; it remains a subtype of
        // `IfcDistributionElement`, which is what the misspelt arm intended.
        "IFCELECTRICDISTRIBUTIONPOINT" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcFlowController,
            has_geometry: true,
        }),
        // Its own IFC2X3 parent, which survives into IFC4X3. This said
        // `IfcDistributionElement` on the reasoning that IFC4 deprecated it in
        // favour of that family -- a claim that was asserted and never
        // measured, and that contradicted the rule every other arm here
        // follows. The bundled IFC2X3 table declares the parent as `IfcElement`
        // (entities-ifc2x3.ts:559) and the entity carries no distribution
        // attribute, so the wider mapping would also have relabelled it in the
        // public `ifcType` and moved it to secondary render priority via
        // `compute_is_simple`. Reported by Codex on #3178.
        "IFCELECTRICALELEMENT" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcElement,
            has_geometry: true,
        }),
        // The two concrete `IfcEdgeFeature` leaves, dropped by IFC4.
        //
        // `IfcFeatureElementSubtraction` is not merely AN ancestor that happens
        // to work. It is the NEAREST SURVIVING one, and that is why these two
        // need an arm at all: walking outward, their own parent is the first
        // casualty and the very next link is the first survivor.
        //
        //     IfcEdgeFeature                 in ifc2x3, NOT in ifc4x3
        //     IfcFeatureElementSubtraction   in ifc2x3, in ifc4x3   <- nearest
        //
        // Mapping there rather than to `IfcOpeningElement` also keeps them out
        // of the void/CSG path, which matches `IfcType::IfcOpeningElement`
        // exactly rather than by inheritance, while still excluding them from
        // construction-projection profiles, which gate on
        // `is_subtype_of(IfcFeatureElement)` -- the link directly above (#979).
        "IFCCHAMFEREDGEFEATURE" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcFeatureElementSubtraction,
            has_geometry: true,
        }),
        "IFCROUNDEDEDGEFEATURE" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcFeatureElementSubtraction,
            has_geometry: true,
        }),
        // IFC4 folded the "Varying" structural actions into their base types,
        // which carry the varying load on an attribute instead. Each maps to
        // its own IFC2X3 supertype, both of which survive into IFC4X3.
        "IFCSTRUCTURALLINEARACTIONVARYING" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcStructuralLinearAction,
            has_geometry: true,
        }),
        "IFCSTRUCTURALPLANARACTIONVARYING" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcStructuralPlanarAction,
            has_geometry: true,
        }),

        // === IFC4.3 stratum subtypes (issue #860) ===
        //
        // The schema enum exposes the abstract base `IfcGeotechnicalStratum`
        // but not the three concrete leaves (`IfcSolidStratum`,
        // `IfcVoidStratum`, `IfcWaterStratum`). Without these, infrastructure
        // models with terrain / soil layers (e.g. the user's UT_Tin_in_MGA_56
        // fixture) come back as `IfcType::Unknown(...)` and
        // `has_geometry_by_name` returns false — the geometry pipeline skips
        // them silently. Map each subtype to the base so its `Body`
        // representation (typically `IfcTriangulatedFaceSet`) is processed by
        // the same code path as any other geotechnical product.
        "IFCSOLIDSTRATUM" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcGeotechnicalStratum,
            has_geometry: true,
        }),
        "IFCVOIDSTRATUM" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcGeotechnicalStratum,
            has_geometry: true,
        }),
        "IFCWATERSTRATUM" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcGeotechnicalStratum,
            has_geometry: true,
        }),

        _ => None,
    }
}

/// Check if an entity name is a known legacy entity
pub fn is_legacy_entity(entity_name: &str) -> bool {
    get_legacy_entity_info(entity_name).is_some()
}

/// Get the IFC4x3 base type for a legacy entity, or None if not legacy
pub fn map_legacy_to_base_type(entity_name: &str) -> Option<IfcType> {
    get_legacy_entity_info(entity_name).map(|info| info.base_type)
}

/// Every key of [`get_legacy_entity_info`]'s match arms, enumerable.
///
/// A `match` on string literals answers "is this name legacy?" but cannot be
/// walked, and callers need to walk it: the cross-language rooted-type sweep
/// (`rust/export/examples/dump_rooted_type_sweep.rs`) has to put every legacy
/// name into its universe, or the gate is structurally blind to exactly the
/// names the two languages are most likely to disagree on -- which is how the
/// three stratum leaves stayed divergent (#3124 review). Rather than leave
/// this as a second hand-maintained list that must agree with the match,
/// `legacy_entity_names_match_the_lookup_arms` below re-derives the arm keys
/// from this module's own source text and asserts set equality, so adding an
/// arm without adding a name here fails the test.
pub const LEGACY_ENTITY_NAMES: &[&str] = &[
    "IFCPRESENTATIONSTYLEASSIGNMENT",
    "IFCBEAMSTANDARDCASE",
    "IFCCOLUMNSTANDARDCASE",
    "IFCMEMBERSTANDARDCASE",
    "IFCPLATESTANDARDCASE",
    "IFCSLABSTANDARDCASE",
    "IFCDOORSTANDARDCASE",
    "IFCWINDOWSTANDARDCASE",
    "IFCOPENINGSTANDARDCASE",
    "IFCSLABELEMENTEDCASE",
    "IFCWALLELEMENTEDCASE",
    "IFCDOORSTYLE",
    "IFCWINDOWSTYLE",
    "IFCPROXY",
    "IFCBUILDINGELEMENT",
    "IFCBUILDINGELEMENTTYPE",
    "IFCEQUIPMENTELEMENT",
    "IFCELECTRICDISTRIBUTIONPOINT",
    "IFCELECTRICALELEMENT",
    "IFCCHAMFEREDGEFEATURE",
    "IFCROUNDEDEDGEFEATURE",
    "IFCSTRUCTURALLINEARACTIONVARYING",
    "IFCSTRUCTURALPLANARACTIONVARYING",
    "IFCSOLIDSTRATUM",
    "IFCVOIDSTRATUM",
    "IFCWATERSTRATUM",
];

#[cfg(test)]
mod legacy_entity_name_tests {
    use super::*;

    /// The arm/const parity check that used to live here is now
    /// `scripts/check-legacy-entity-coverage.mjs`, which already reads this
    /// file to derive the arm keys and gained a `LEGACY_ENTITY_NAMES`
    /// comparison to go with it.
    ///
    /// It moved because the only way to state it in-crate was `include_str!`
    /// of this module's own source, which is a source-text assertion — banned
    /// by AGENTS.md and flagged by `check-rust-source-text-assertions` (#3195).
    /// The repo had already made the same call for
    /// `check-clash-degenerate-reason-parity.mjs`: a claim about two SOURCES
    /// belongs in a lint. The gate is also strictly stronger here, since it
    /// fails on drift in BOTH directions and its own harness proves it cannot
    /// pass by extracting nothing.
    ///
    /// Every listed name really is legacy -- the cheap direction, but it also
    /// pins that the const holds arm keys and not, say, base-type names.
    #[test]
    fn every_listed_name_resolves_as_legacy() {
        for &name in LEGACY_ENTITY_NAMES {
            assert!(is_legacy_entity(name), "{name} is not a legacy entity");
        }
    }
}
