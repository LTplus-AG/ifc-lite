// SPDX-License-Identifier: MPL-2.0
//! Schema-driven `IfcRoot` rootedness check, extracted as a standalone unit.
//!
//! GlobalId reconciliation across a merged/federated STEP export first needs
//! to know which entity types actually carry a GlobalId as their first
//! attribute -- only `IfcRoot` subtypes do. A hand-maintained denylist of
//! "non-rooted types whose first attribute happens to be a string" is the
//! natural first cut, but it can only ever be as complete as whoever last
//! audited the schema for such types, and staleness fails silently: a
//! forgotten entry has its Name/Identifier misread as a GlobalId and
//! re-stamped, corrupting the entity.
//!
//! For example `IfcColourRgb` (upper-case `IFCCOLOURRGB`) inherits `Name :
//! OPTIONAL IfcLabel` as its first attribute from `IfcColourSpecification`,
//! an `IfcPresentationItem` -- not an `IfcRoot` subtype
//! (`packages/codegen/schemas/IFC4X3.exp:4972-4988`). A 22-character colour
//! name is exactly GlobalId-shaped and would be silently treated as one by
//! any denylist that omits `IFCCOLOURRGB`.
//!
//! This module asks the generated type universe directly via
//! [`ifc_lite_core::IfcType::is_subtype_of`], so rootedness follows EXPRESS
//! inheritance instead of a hand-maintained classification table. The three
//! documented exporter-only stratum spellings are the sole bounded exception;
//! unknown vendor names fail closed.

// Wired into `merged.rs`'s GlobalId reconciliation (`export_merged_with_stats`),
// which previously carried its own near-identical copy of this same
// schema-driven check -- exactly the "two lists that must agree" drift shape
// this module's own doc warns about (see #3015). The leading-GlobalId scan
// itself lives in `ifc_lite_core::guid::leading_global_id`; the merged
// exporter's `extract_global_id_fast` is `is_rooted_type` plus that scan.

use ifc_lite_core::IfcType;

/// True if `type_name` (case-insensitive) is an `IfcRoot` subtype and so
/// carries a GlobalId as its first attribute.
///
/// Generated EXPRESS inheritance decides recognized names. The three
/// exporter-only stratum aliases are rooted compatibility spellings; all other
/// unknown names fail closed.
pub fn is_rooted_type(type_name: &str) -> bool {
    let upper = type_name.to_ascii_uppercase();
    if ifc_lite_core::is_exporter_stratum_alias(&upper) {
        return true;
    }
    IfcType::from_str(&upper).is_subtype_of(IfcType::IfcRoot)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rooted-type guard plus the shared leading-GlobalId scan, exactly the
    /// composition `merged::guid::extract_global_id_fast` ships.
    fn extract_leading_guid(type_name: &str, line: &[u8]) -> Option<String> {
        is_rooted_type(type_name)
            .then(|| ifc_lite_core::guid::leading_global_id(line).map(str::to_string))
            .flatten()
    }

    /// The denylist-defeating case: `IFCCOLOURRGB` is not an `IfcRoot`
    /// subtype (it derives from `IfcPresentationItem` via
    /// `IfcColourSpecification`), but its inherited `Name` attribute is a
    /// 22-character string here -- exactly GlobalId-shaped. A denylist that
    /// forgot this entry would misread it as a GlobalId; the schema-driven
    /// check must not.
    #[test]
    fn colour_rgb_name_is_not_read_as_a_global_id() {
        // 22-char Name, GlobalId-shaped by construction.
        let line = b"#10=IFCCOLOURRGB('AbCdEfGhIjKlMnOpQrStUv',0.1,0.2,0.3);";
        assert_eq!(extract_leading_guid("IFCCOLOURRGB", line), None);
        assert!(!is_rooted_type("IFCCOLOURRGB"));
    }

    /// A genuine `IfcRoot` subtype with a 22-char GlobalId first attribute
    /// IS read as one.
    #[test]
    fn wall_global_id_is_extracted() {
        let line = b"#20=IFCWALL('1x2y3z4A5b6C7d8E9f0GhI',#2,'Wall-01',$,$,#3,#4,$,$);";
        assert_eq!(
            extract_leading_guid("IFCWALL", line),
            Some("1x2y3z4A5b6C7d8E9f0GhI".to_string())
        );
        assert!(is_rooted_type("IFCWALL"));
    }

    /// IFC2X3-only rooted type: the generated supported-schema universe keeps
    /// its exact name while rootedness remains compatible with the legacy path.
    #[test]
    fn door_style_keeps_its_exact_name_and_is_rooted() {
        assert_eq!(IfcType::from_str("IFCDOORSTYLE"), IfcType::IfcDoorStyle);
        assert!(is_rooted_type("IFCDOORSTYLE"));

        let line = b"#30=IFCDOORSTYLE('9zY8xW7vU6tS5rQ4pO3nM2',#2,'DoorStyle',$,$,$,$,$,.DOOR.,.SINGLE_SWING_LEFT.,.T.,.T.);";
        assert_eq!(
            extract_leading_guid("IFCDOORSTYLE", line),
            Some("9zY8xW7vU6tS5rQ4pO3nM2".to_string())
        );
    }

    /// `IFCPROXY`, the other legacy case cited alongside `IFCDOORSTYLE`
    /// (IFC2X3 AND IFC4; dropped from IFC4X3).
    #[test]
    fn proxy_keeps_its_exact_name_and_is_rooted() {
        assert_eq!(IfcType::from_str("IFCPROXY"), IfcType::IfcProxy);
        assert!(is_rooted_type("IFCPROXY"));
    }

    /// The three IFC4X3 stratum leaves. The generated enum models only their
    /// abstract base `IfcGeotechnicalStratum`, so a bare `from_str` answers
    /// `Unknown`, and none is in `LEGACY_ROOTED_TYPES` -- yet the JS
    /// classifier resolves them through `ENTITY_NAME_ALIASES` and answers
    /// rooted. That disagreement was invisible to the parity gate until the
    /// sweep's universe grew to include the alias names (#3124 review);
    /// through `export_merged` it meant a GlobalId shared by two models was
    /// reconciled for `IFCWALL` but left duplicated for `IFCSOLIDSTRATUM`.
    #[test]
    fn stratum_leaves_are_rooted_through_the_legacy_entity_table() {
        for name in ["IFCSOLIDSTRATUM", "IFCVOIDSTRATUM", "IFCWATERSTRATUM"] {
            assert!(
                matches!(IfcType::from_str(name), IfcType::Unknown(_)),
                "{name} now resolves in the generated schema; this test's premise is stale"
            );
            assert!(is_rooted_type(name), "{name} should be rooted");
        }

        let line = b"#50=IFCSOLIDSTRATUM('3aB4cD5eF6gH7iJ8kL9mN0',#2,'Stratum',$,$,#3,#4,.SOLID.);";
        assert_eq!(
            extract_leading_guid("IFCSOLIDSTRATUM", line),
            Some("3aB4cD5eF6gH7iJ8kL9mN0".to_string())
        );
    }

    /// The other direction of the same widening: resolving through
    /// `legacy_aware_ifc_type` must not turn a legacy name into a rooted one
    /// just because it is legacy. `IFCPRESENTATIONSTYLEASSIGNMENT` is in
    /// `legacy_entities.rs` and maps to `IfcPresentationStyle`, which is not
    /// an `IfcRoot` subtype, so it must stay non-rooted -- its first
    /// attribute is a list, and treating it as a GlobalId is the corruption
    /// this module exists to prevent.
    #[test]
    fn a_legacy_name_with_a_non_rooted_base_stays_non_rooted() {
        assert!(!is_rooted_type("IFCPRESENTATIONSTYLEASSIGNMENT"));
    }

    /// A genuinely unknown/vendor type must NOT be treated as rooted -- the
    /// safe direction. Getting this wrong (assuming rootedness for anything
    /// unrecognised) reintroduces the corruption this check exists to
    /// prevent, just from the opposite side of the denylist's failure mode.
    #[test]
    fn unknown_vendor_type_is_not_rooted() {
        assert!(matches!(
            IfcType::from_str("IFCACMEWIDGETPROXY"),
            IfcType::Unknown(_)
        ));
        assert!(!is_rooted_type("IFCACMEWIDGETPROXY"));

        let line = b"#40=IFCACMEWIDGETPROXY('AbCdEfGhIjKlMnOpQrStUv',$,$);";
        assert_eq!(extract_leading_guid("IFCACMEWIDGETPROXY", line), None);
    }

    /// Case-insensitivity: lower/mixed-case type names resolve the same way
    /// as upper-case (STEP type keywords are conventionally upper-case, but
    /// the check itself does not assume it).
    #[test]
    fn type_name_matching_is_case_insensitive() {
        assert!(is_rooted_type("ifcWall"));
        assert!(is_rooted_type("ifcdoorstyle"));
        assert!(!is_rooted_type("ifcColourRgb"));
        // CamelCase spelling of a name that ONLY the generated legacy table
        // (not `IfcType::from_str`) resolves as rooted.
        assert!(is_rooted_type("IfcProxy"));
        assert!(is_rooted_type("IfcBuildingElement"));
    }

    /// `IFCSCHEDULETIMECONTROL` and `IFCRELASSIGNSTASKS` are rooted names
    /// `rust/core/src/legacy_entities.rs` does NOT carry at all (confirmed:
    /// `grep -n "IFCSCHEDULETIMECONTROL\|IFCRELASSIGNSTASKS"
    /// rust/core/src/legacy_entities.rs` matches nothing), so `is_rooted_type`
    /// used to answer `true` only through `LEGACY_ROOTED_TYPES`. Their exact
    /// generated variants now carry the EXPRESS parent chain too; keep the
    /// transitional table entries pinned until #4203 removes that table.
    #[test]
    fn a_table_only_legacy_name_is_rooted_only_through_the_generated_table() {
        assert!(is_rooted_type("IFCSCHEDULETIMECONTROL"));
        assert!(is_rooted_type("ifcscheduletimecontrol"));
        assert!(is_rooted_type("IfcRelAssignsTasks"));
    }

    /// Every bounded compatibility alias remains rooted without becoming an
    /// invented generated schema variant.
    #[test]
    fn every_compatibility_alias_is_rooted_without_an_invented_variant() {
        for &name in ifc_lite_core::EXPORTER_STRATUM_ALIASES {
            assert!(matches!(IfcType::from_str(name), IfcType::Unknown(_)));
            assert!(is_rooted_type(name), "{name} should be rooted");
        }
    }
}
