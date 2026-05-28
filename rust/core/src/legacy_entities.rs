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
        // closest modern equivalent; both carry geometry.
        "IFCEQUIPMENTELEMENT" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcDistributionElement,
            has_geometry: true,
        }),
        "IFCELECTRICALDISTRIBUTIONPOINT" => Some(LegacyEntityInfo {
            base_type: IfcType::IfcDistributionElement,
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
