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
//! This module instead asks the generated schema directly via
//! [`ifc_lite_core::IfcType::is_subtype_of`], which can't drift out of sync
//! with the schema it's generated from. The one gap: `rust-core`'s generated
//! `IfcType` table is derived from IFC4X3 alone, so a handful of rooted
//! types that IFC4X3 dropped or renamed (`IFCPROXY`, `IFCDOORSTYLE`, the
//! IFC4 `*StandardCase`/`*ElementedCase` family, ...) resolve to
//! `IfcType::Unknown` and would wrongly read as non-rooted. Two things close
//! that gap: the lookup goes through
//! [`ifc_lite_core::legacy_aware_ifc_type`], which resolves the names
//! `rust/core/src/legacy_entities.rs` maps to a surviving base type, and
//! [`LEGACY_ROOTED_TYPES`] covers the rooted IFC2X3/IFC4 names that table
//! does not carry. An unrecognised type in neither stays non-rooted -- the
//! safe direction, since assuming rootedness for a genuinely unknown/vendor
//! type is the same corruption this check exists to prevent.
//!
//! The JS classifier (`isRootedType` in
//! `packages/export/src/merged-exporter.ts`) has the same two-part shape --
//! a schema-union walk plus the `ENTITY_NAME_ALIASES` table that mirrors
//! `legacy_entities.rs` -- and both are pinned to one shared fixture by
//! `rust/export/tests/rooted_type_parity.rs` and
//! `packages/export/src/rooted-type-sweep.parity.test.ts`. That fixture's
//! universe includes the alias names precisely because omitting them once
//! let three of them disagree across the two languages unnoticed (#3124
//! review).

// Wired into `merged.rs`'s GlobalId reconciliation (`export_merged_with_stats`),
// which previously carried its own near-identical copy of this same
// schema-driven check -- exactly the "two lists that must agree" drift shape
// this module's own doc warns about (see #3015). `extract_leading_guid` is
// this crate's only sanctioned way to read a STEP line's leading GlobalId.

use ifc_lite_core::IfcType;

/// True if `type_name` (case-insensitive) is an `IfcRoot` subtype and so
/// carries a GlobalId as its first attribute.
///
/// Two-step: the generated IFC4X3 schema settles it for any type it
/// recognises; [`LEGACY_ROOTED_TYPES`] settles it for the few genuinely-rooted
/// IFC2X3/IFC4 types IFC4X3 no longer has. Anything else -- any name neither
/// table recognises -- is not rooted.
///
/// The schema step goes through [`ifc_lite_core::legacy_aware_ifc_type`], not
/// a bare `IfcType::from_str`. `from_str` answers `Unknown` for the three
/// IFC4X3 stratum leaves (`IFCSOLIDSTRATUM`, `IFCVOIDSTRATUM`,
/// `IFCWATERSTRATUM`), which the generated enum models only by their abstract
/// base `IfcGeotechnicalStratum` -- a rooted type. The JS classifier resolves
/// them through its mirror table (`ENTITY_NAME_ALIASES` in
/// `packages/parser/src/ifc-schema.ts`) and answers `true`, so a bare
/// `from_str` here made the two languages disagree: `export_merged` would
/// reconcile a shared GlobalId across two models for `IFCWALL` but leave a
/// duplicate for `IFCSOLIDSTRATUM` (#3124 review). `legacy_aware_ifc_type` is
/// the same resolution every other classifying pass in the workspace uses
/// (see its own doc on #1496), so this is the general fix, not a carve-out
/// for three names.
pub fn is_rooted_type(type_name: &str) -> bool {
    if ifc_lite_core::legacy_aware_ifc_type(type_name).is_subtype_of(IfcType::IfcRoot) {
        return true;
    }
    is_legacy_rooted_type(&type_name.to_ascii_uppercase())
}

/// Rooted entity types that exist in IFC2X3 and/or IFC4 but were dropped or
/// renamed by IFC4X3 -- the only schema `rust-core`'s generated `IfcType`
/// table is derived from (`rust/core/src/generated/schema.rs`). For these,
/// `IfcType::from_str` resolves to `Unknown`, which `is_subtype_of(IfcRoot)`
/// correctly refuses on its own.
///
/// Some of these names ALSO appear in `rust/core/src/legacy_entities.rs` and
/// so are already rooted by the time [`is_rooted_type`]'s first branch runs
/// (`IFCDOORSTYLE` -> `IfcDoorType`, `IFCPROXY` ->
/// `IfcBuildingElementProxy`, the `*StandardCase` family, ...). The overlap
/// is deliberate, not dead weight: that table's mandate is "which surviving
/// type does this legacy name behave like", which is a different question
/// from "is this name rooted", and it deliberately omits rooted non-product
/// names like `IFCSCHEDULETIMECONTROL` and the removed `IFCREL*` types that
/// only this list carries.
///
/// Independently re-verified (2026-08-20) by walking each name's parent
/// chain in `@ifc-lite/data`'s generated IFC2X3 and IFC4 entity tables
/// (`packages/data/src/ifc-schema/generated/entities-ifc2x3.ts`,
/// `entities-ifc4.ts`) until it reaches `IfcRoot` or a dead end, and
/// confirming absence from `entities-ifc4x3.ts` (i.e. that
/// `IfcType::from_str` really does yield `Unknown` for each). All 54
/// resolved to `IfcRoot` in at least one of IFC2X3/IFC4 and none are present
/// in IFC4X3. Re-verify the same way (or regenerate from a diff of those
/// three tables) rather than editing this list ad hoc.
fn is_legacy_rooted_type(upper: &str) -> bool {
    LEGACY_ROOTED_TYPES.contains(&upper)
}

pub const LEGACY_ROOTED_TYPES: &[&str] = &[
    "IFCBEAMSTANDARDCASE",
    "IFCBUILDINGELEMENT",
    "IFCBUILDINGELEMENTCOMPONENT",
    "IFCBUILDINGELEMENTTYPE",
    "IFCCHAMFEREDGEFEATURE",
    "IFCCOLUMNSTANDARDCASE",
    "IFCCONDITION",
    "IFCCONDITIONCRITERION",
    "IFCDOORSTANDARDCASE",
    "IFCDOORSTYLE",
    "IFCEDGEFEATURE",
    "IFCELECTRICDISTRIBUTIONPOINT",
    "IFCELECTRICHEATERTYPE",
    "IFCELECTRICALBASEPROPERTIES",
    "IFCELECTRICALCIRCUIT",
    "IFCELECTRICALELEMENT",
    "IFCENERGYPROPERTIES",
    "IFCEQUIPMENTELEMENT",
    "IFCEQUIPMENTSTANDARD",
    "IFCFLUIDFLOWPROPERTIES",
    "IFCFURNITURESTANDARD",
    "IFCGASTERMINALTYPE",
    "IFCMEMBERSTANDARDCASE",
    "IFCMOVE",
    "IFCOPENINGSTANDARDCASE",
    "IFCORDERACTION",
    "IFCPLATESTANDARDCASE",
    "IFCPROJECTORDERRECORD",
    "IFCPROXY",
    "IFCRELASSIGNSTASKS",
    "IFCRELASSIGNSTOPROJECTORDER",
    "IFCRELASSOCIATESAPPLIEDVALUE",
    "IFCRELASSOCIATESPROFILEPROPERTIES",
    "IFCRELCONNECTSSTRUCTURALELEMENT",
    "IFCRELINTERACTIONREQUIREMENTS",
    "IFCRELOCCUPIESSPACES",
    "IFCRELOVERRIDESPROPERTIES",
    "IFCRELSCHEDULESCOSTITEMS",
    "IFCROUNDEDEDGEFEATURE",
    "IFCSCHEDULETIMECONTROL",
    "IFCSERVICELIFE",
    "IFCSERVICELIFEFACTOR",
    "IFCSLABELEMENTEDCASE",
    "IFCSLABSTANDARDCASE",
    "IFCSOUNDPROPERTIES",
    "IFCSOUNDVALUE",
    "IFCSPACEPROGRAM",
    "IFCSPACETHERMALLOADPROPERTIES",
    "IFCSTRUCTURALLINEARACTIONVARYING",
    "IFCSTRUCTURALPLANARACTIONVARYING",
    "IFCTIMESERIESSCHEDULE",
    "IFCWALLELEMENTEDCASE",
    "IFCWINDOWSTANDARDCASE",
    "IFCWINDOWSTYLE",
];

/// The leading 22-char GlobalId of a rooted entity's raw STEP line, or `None`
/// if the type is not rooted or the first attribute is not a GlobalId-shaped
/// string.
///
/// This crate's **only** sanctioned way to read a STEP line's leading
/// GlobalId, and the sole production GlobalId path in the merged exporter:
/// `merged::leading_guid` is a one-line wrapper around it, and
/// `export_merged_with_stats` calls that wrapper at the single point where
/// GlobalId reconciliation decides whether a line's first attribute is an id
/// to dedupe or ordinary model data to leave alone. Nothing else in the
/// crate re-derives that decision -- `merged.rs` used to carry a
/// byte-for-byte copy of the rootedness check and no longer does, which is
/// the whole point of this module (#3015).
///
/// So a mistake here is not confined to a demo: reading a non-rooted
/// entity's `Name` as a GlobalId re-stamps it during merge, and missing a
/// rooted entity leaves a duplicate GlobalId in the output, which is exactly
/// the IFC spec violation the reconciliation step exists to prevent.
pub fn extract_leading_guid(type_name: &str, line: &[u8]) -> Option<String> {
    if !is_rooted_type(type_name) {
        return None;
    }
    let open = line.iter().position(|&b| b == b'(')?;
    let mut i = open + 1;
    while i < line.len() && line[i].is_ascii_whitespace() {
        i += 1;
    }
    if line.get(i) != Some(&b'\'') {
        return None;
    }
    let after_q1 = &line[i + 1..];
    let q2 = after_q1.iter().position(|&b| b == b'\'')?;
    let raw = &after_q1[..q2];
    let s = std::str::from_utf8(raw).ok()?;
    is_global_id_shaped(s).then(|| s.to_string())
}

/// True for a 22-character token drawn entirely from the buildingSMART
/// GlobalId alphabet.
pub(crate) fn is_global_id_shaped(s: &str) -> bool {
    s.len() == 22
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$')
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// IFC2X3-only rooted type: a bare `IfcType::from_str` yields `Unknown`
    /// for `IFCDOORSTYLE` because the IFC4X3-generated table doesn't carry
    /// it, so this case can only pass through one of the two legacy paths --
    /// `legacy_aware_ifc_type` (which maps it to `IfcDoorType`) or
    /// `LEGACY_ROOTED_TYPES`, which also lists it.
    #[test]
    fn door_style_is_rooted_via_the_legacy_table() {
        assert!(matches!(
            IfcType::from_str("IFCDOORSTYLE"),
            IfcType::Unknown(_)
        ));
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
    fn proxy_is_rooted_via_the_legacy_table() {
        assert!(matches!(IfcType::from_str("IFCPROXY"), IfcType::Unknown(_)));
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
            assert!(
                !LEGACY_ROOTED_TYPES.contains(&name),
                "{name} is in LEGACY_ROOTED_TYPES, so it no longer exercises the alias path"
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
        assert!(ifc_lite_core::is_legacy_entity(
            "IFCPRESENTATIONSTYLEASSIGNMENT"
        ));
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
    }

    /// All 54 legacy entries resolve to `Unknown` against the generated
    /// IFC4X3-only schema (that's the gap this table exists to close) and
    /// are individually recognised as rooted.
    #[test]
    fn every_legacy_entry_is_unknown_to_the_generated_schema_and_rooted_here() {
        for &name in LEGACY_ROOTED_TYPES {
            assert!(
                matches!(IfcType::from_str(name), IfcType::Unknown(_)),
                "{name} unexpectedly resolved in the generated IFC4X3 schema; \
                 it may have been added there and no longer needs the legacy table"
            );
            assert!(is_rooted_type(name), "{name} should be rooted");
        }
    }
}
