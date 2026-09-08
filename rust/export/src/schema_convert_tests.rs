// SPDX-License-Identifier: MPL-2.0
//! Tests for [`super::schema_convert`]. Split out of `schema_convert.rs` to
//! keep that module under the 400-line rule (AGENTS.md), matching the
//! `schema_helpers.rs` / `schema_helpers_tests.rs` pattern.
//!
//! Includes the Rust twin of TS PR #3653
//! (`schema-converter-door-window-type.test.ts`): `ifc-lite export --format
//! step` on an IFC4 model downgraded to IFC2X3 silently destroyed every
//! IfcDoorType/IfcWindowType. `map_4_to_2x3` had no entry for either, so
//! `convert_entity_type` left the type name unchanged, `should_skip_entity`
//! never matched it either, and the un-renamed type sailed through
//! `convert_step_line` as an unrecognized IFC2X3 type name — producing an
//! invalid `IFCDOORTYPE(...)` line in an IFC2X3 file (the TS side
//! additionally fell through to an IFCPROXY substitution via a different
//! code path, `resolveUnrepresentedEntity`; the net defect is the same: the
//! door/window type's own identity is not carried into IFC2X3 as
//! `IfcDoorStyle`/`IfcWindowStyle`).

use super::*;

#[test]
fn entity_type_renames() {
    assert_eq!(convert_entity_type("IFCBURNERTYPE", "IFC4", "IFC2X3"), "IFCGASTERMINALTYPE");
    assert_eq!(convert_entity_type("IFCCHIMNEY", "IFC4", "IFC2X3"), "IFCBUILDINGELEMENTPROXY");
    assert_eq!(convert_entity_type("IFCWALL", "IFC2X3", "IFC4"), "IFCWALL"); // unchanged
    // chained 4X3 → 2X3 (via 4): IfcFacility → IfcBuilding
    assert_eq!(convert_entity_type("IFCFACILITY", "IFC4X3", "IFC2X3"), "IFCBUILDING");
}

/// The UPGRADE table (`map_2x3_to_4`) had no test in this crate: the only
/// 2X3 → 4 case above is `IFCWALL`, a type that is unchanged in every
/// schema, so replacing the whole arm with a pass-through left the entire
/// `ifc-lite-export` suite green (confirmed by mutation). The TS twin
/// `packages/export/src/schema-converter.test.ts` covers this direction;
/// the Rust port is what the CLI, server and wasm actually run.
///
/// Concretely, un-renamed output is an INVALID file: none of these three
/// type names exists in IFC4.
#[test]
fn ifc2x3_only_types_are_renamed_on_upgrade() {
    for (from, want) in [
        ("IFCELECTRICDISTRIBUTIONPOINT", "IFCELECTRICDISTRIBUTIONBOARD"),
        ("IFCGASTERMINALTYPE", "IFCBURNERTYPE"),
        ("IFCEQUIPMENTELEMENT", "IFCBUILDINGELEMENTPROXY"),
    ] {
        assert_eq!(convert_entity_type(from, "IFC2X3", "IFC4"), want, "2X3 → 4");
        // 2X3 → 4X3 and 2X3 → 5 route through the same table.
        assert_eq!(convert_entity_type(from, "IFC2X3", "IFC4X3"), want, "2X3 → 4X3");
        assert_eq!(convert_entity_type(from, "IFC2X3", "IFC5"), want, "2X3 → 5");
    }
}

/// The direct `4X3 → 4` arm was only ever reached by types it does NOT
/// rename: `entity_type_renames` chains through it on the way to 2X3, and
/// `alignment_becomes_proxy_on_downgrade` hits the proxy branch instead.
/// Replacing the arm with a pass-through likewise left the suite green.
/// `IFC5 → IFC4` shares the arm, so it is pinned here too — nothing else
/// in this crate exercises `canon`'s IFC5 branch at all.
#[test]
fn ifc4x3_and_ifc5_types_are_renamed_down_to_ifc4() {
    for (from, want) in [
        ("IFCBRIDGE", "IFCBUILDING"),
        ("IFCBRIDGEPART", "IFCBUILDINGSTOREY"),
        ("IFCPAVEMENT", "IFCSLAB"),
        ("IFCCAISSONFOUNDATION", "IFCFOOTING"),
        ("IFCDISTRIBUTIONBOARD", "IFCELECTRICDISTRIBUTIONBOARD"),
    ] {
        assert_eq!(convert_entity_type(from, "IFC4X3", "IFC4"), want, "4X3 → 4");
        assert_eq!(convert_entity_type(from, "IFC5", "IFC4"), want, "5 → 4");
    }
    // 4 ↔ 4X3 ↔ 5 carry no renames, and IFCX* canonicalizes to IFC5.
    assert_eq!(convert_entity_type("IFCWALL", "IFC4", "IFC5"), "IFCWALL");
    assert_eq!(convert_entity_type("IFCBRIDGE", "IFCX", "IFC4"), "IFCBUILDING");
    assert!(!needs_conversion("IFC5", "IFCX"));
}

#[test]
fn downgrade_trims_attributes() {
    // IfcWall in IFC4 has 9 attrs (trailing PredefinedType); IFC2X3 keeps 8.
    let line = "#5=IFCWALL('guid',$,'W1',$,$,#6,#7,'tag',.STANDARD.);";
    let out = convert_step_line(line, "IFC4", "IFC2X3", 5);
    assert!(out.starts_with("#5=IFCWALL("), "type kept");
    assert!(!out.contains(".STANDARD."), "9th attr (PredefinedType) trimmed");
    // 8 top-level attrs remain → 7 commas.
    let inner = &out["#5=IFCWALL(".len()..out.len() - 2];
    assert_eq!(inner.split(',').count(), 8, "trimmed to 8 attrs");
}

#[test]
fn nested_attrs_not_split_when_trimming() {
    // Commas inside a nested list must not count as top-level separators.
    let line = "#9=IFCWALL('g',$,$,$,$,(#1,#2,#3),#7,'t',.STANDARD.);";
    let out = convert_step_line(line, "IFC4", "IFC2X3", 9);
    assert!(out.contains("(#1,#2,#3)"), "nested list preserved intact");
    assert!(!out.contains(".STANDARD."), "trailing attr trimmed");
}

#[test]
fn alignment_becomes_proxy_on_downgrade() {
    let line = "#3=IFCALIGNMENTHORIZONTAL('g',$,$,$,$,#4);";
    let out = convert_step_line(line, "IFC4X3", "IFC4", 3);
    assert!(out.starts_with("#3=IFCPROXY("), "alignment → proxy");
    assert!(out.contains("'IFCALIGNMENTHORIZONTAL'"), "original type recorded as name");
}

/// PINS the schema-downgrade proxy-GlobalId divergence between the two
/// exporters (#3015) AS divergence -- it does not fix it. Which side wins
/// is a maintainer decision, not something a test should resolve
/// unilaterally.
///
/// `placeholder_guid` here derives the id purely from the express id
/// (`id as u64 + 0x1000_0000`, base64-stamped). The TypeScript twin
/// (`convertStepLine` in `packages/export/src/schema-converter.ts`)
/// derives it from `deterministicGlobalId` of the WHOLE source line
/// (`ifcproxy:{prefix}{entityType}({attrs})`) -- a different algorithm
/// entirely, not just a different seed to the same one. Verified by
/// actually running both on the byte-identical input line below;
/// `packages/export/src/schema-converter.test.ts`'s
/// `placeholder_guid_diverges_from_the_rust_mint_pinned_not_fixed` pins
/// the TS side of the same pair.
///
/// If this test ever starts failing because the values converged, that
/// is good news -- update the doc here (and the TS twin) to say so,
/// don't just delete the assertion.
#[test]
fn placeholder_guid_diverges_from_the_typescript_mint_pinned_not_fixed() {
    let line = "#42=IFCALIGNMENTSEGMENT('2K5H1$Zs9CQuKQFQKQFQKQ',#1,'A',$,$,#7,#9,$);";
    let out = convert_step_line(line, "IFC4X3", "IFC4", 42);
    let guid = out.split('\'').nth(1).expect("IFCPROXY line has a quoted GlobalId");
    assert_eq!(
        guid, "00000000000000000G000g",
        "Rust's placeholder_guid(42) output changed -- update this pin (and check whether \
         it now agrees with the TS twin, in which case update both docs to say so)"
    );
    assert_ne!(
        guid, "3m5OyAyREn46dEymqijDwc",
        "this is the TS side's minted value for the byte-identical input line -- if Rust \
         now matches it, the divergence has been resolved; update both tests' docs instead \
         of silently dropping this assertion"
    );
}

#[test]
fn no_conversion_is_identity() {
    let line = "#1=IFCWALL('g',$,$);";
    assert_eq!(convert_step_line(line, "IFC4", "IFC4", 1), line);
    assert!(!needs_conversion("IFC4", "IFC4"));
    assert!(needs_conversion("IFC2X3", "IFC4"));
}

#[test]
fn ifcdoortype_maps_to_ifcdoorstyle_preserving_globalid_and_name() {
    // IfcDoorType(IFC4) attrs: GlobalId,OwnerHistory,Name,Description,
    // ApplicableOccurrence,HasPropertySets,RepresentationMaps,Tag,
    // ElementType,PredefinedType,OperationType,ParameterTakesPrecedence,
    // UserDefinedOperationType
    let line = "#1=IFCDOORTYPE('1mW6gHB0W7lxCAqIKVEzia',#2,'Door Type',$,$,(#3),(#4),'tag',\
                $,.DOOR.,.SINGLE_SWING_LEFT.,.T.,$);";
    let out = convert_step_line(line, "IFC4", "IFC2X3", 1);

    assert!(!out.contains("IFCPROXY"), "must not fall back to a proxy: {out}");
    assert!(out.starts_with("#1=IFCDOORSTYLE("), "renamed to IfcDoorStyle: {out}");
    // GlobalId, Name, HasPropertySets, RepresentationMaps, Tag all survive.
    assert!(out.contains("'1mW6gHB0W7lxCAqIKVEzia'"), "GlobalId preserved: {out}");
    assert!(out.contains("'Door Type'"), "Name preserved: {out}");
    assert!(out.contains("(#3)"), "HasPropertySets preserved: {out}");
    assert!(out.contains("(#4)"), "RepresentationMaps preserved: {out}");
    assert!(out.contains("'tag'"), "Tag preserved: {out}");
    // IfcDoorStyle(IFC2X3) attrs: GlobalId,OwnerHistory,Name,Description,
    // ApplicableOccurrence,HasPropertySets,RepresentationMaps,Tag,
    // OperationType,ConstructionType,ParameterTakesPrecedence,Sizeable
    assert_eq!(
        out,
        "#1=IFCDOORSTYLE('1mW6gHB0W7lxCAqIKVEzia',#2,'Door Type',$,$,(#3),(#4),'tag',\
         .SINGLE_SWING_LEFT.,$,.T.,$);"
    );
}

#[test]
fn ifcwindowtype_maps_to_ifcwindowstyle_preserving_globalid_and_name() {
    // IfcWindowType(IFC4) attrs: …,Tag,ElementType,PredefinedType,
    // PartitioningType,ParameterTakesPrecedence,UserDefinedPartitioningType
    let line = "#1=IFCWINDOWTYPE('3Vnz8SzMO$_GklsTTZo$zj',#2,'Window Type',$,$,$,$,'tag',\
                $,.WINDOW.,.SINGLE_PANEL.,.T.,$);";
    let out = convert_step_line(line, "IFC4", "IFC2X3", 1);

    assert!(!out.contains("IFCPROXY"), "must not fall back to a proxy: {out}");
    assert!(out.starts_with("#1=IFCWINDOWSTYLE("), "renamed to IfcWindowStyle: {out}");
    assert!(out.contains("'3Vnz8SzMO$_GklsTTZo$zj'"), "GlobalId preserved: {out}");
    assert!(out.contains("'Window Type'"), "Name preserved: {out}");
}

#[test]
fn ifcdoorstyle_upgrade_leg_is_a_pure_pass_through() {
    // IfcDoorStyle is valid (deprecated) in IFC4 too, so IFC2X3 -> IFC4 was
    // never the buggy direction: no rename entry, no attribute remap.
    let line = "#1=IFCDOORSTYLE('1mW6gHB0W7lxCAqIKVEzia',#2,'Door Style',$,$,$,$,$,\
                .SINGLE_SWING_LEFT.,$,.T.,$);";
    let out = convert_step_line(line, "IFC2X3", "IFC4", 1);
    assert_eq!(out, line, "upgrade leg is untouched: {out}");
}

#[test]
fn other_ifc2x3_downgrade_renames_still_use_positional_trim() {
    // Control: the by-name remap is scoped to exactly IFCDOORTYPE/
    // IFCWINDOWTYPE, not applied to every IFC4->IFC2X3 rename.
    let line = "#5=IFCCHIMNEY('g',$,'C1',$,$,#6,#7,'tag',.USERDEFINED.);";
    let out = convert_step_line(line, "IFC4", "IFC2X3", 5);
    assert!(out.starts_with("#5=IFCBUILDINGELEMENTPROXY("), "renamed via positional path: {out}");
    // IfcBuildingElementProxy caps at 9 IFC2X3 attrs; this line has exactly 9, so nothing trims.
    assert!(out.contains(".USERDEFINED."), "positional trim/pass-through unaffected: {out}");
}
