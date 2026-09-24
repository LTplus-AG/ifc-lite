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

/// A fill with no owner history to write: the conversion itself, unchanged.
fn none() -> Ifc2x3SlotFill {
    Ifc2x3SlotFill::new(None)
}

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
    let out = convert_step_line(line, "IFC4", "IFC2X3", 5, &mut none(), None).unwrap();
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
    let out = convert_step_line(line, "IFC4", "IFC2X3", 9, &mut none(), None).unwrap();
    assert!(out.contains("(#1,#2,#3)"), "nested list preserved intact");
    assert!(!out.contains(".STANDARD."), "trailing attr trimmed");
}

#[test]
fn alignment_becomes_proxy_on_downgrade() {
    let line = "#3=IFCALIGNMENTHORIZONTAL('g',$,$,$,$,#4);";
    let out = convert_step_line(line, "IFC4X3", "IFC4", 3, &mut none(), None).unwrap();
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
    let out = convert_step_line(line, "IFC4X3", "IFC4", 42, &mut none(), None).unwrap();
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
    assert_eq!(convert_step_line(line, "IFC4", "IFC4", 1, &mut none(), None).unwrap(), line);
    assert!(!needs_conversion("IFC4", "IFC4"));
    assert!(needs_conversion("IFC2X3", "IFC4"));
}

#[test]
fn ifcdoortype_maps_to_ifcdoorstyle_preserving_globalid_and_name() {
    // IfcDoorType(IFC4) attrs: GlobalId,OwnerHistory,Name,Description,
    // ApplicableOccurrence,HasPropertySets,RepresentationMaps,Tag,
    // ElementType,PredefinedType,OperationType,ParameterTakesPrecedence,
    // UserDefinedOperationType
    // Non-ASCII in the Name: the by-name remap rebuilds the list on every
    // record, and #4200's splitter mojibaked it (`Ã¶` for `ö`).
    let line = "#1=IFCDOORTYPE('1mW6gHB0W7lxCAqIKVEzia',#2,'Türtyp Größe',$,$,(#3),(#4),'tag',\
                $,.DOOR.,.SINGLE_SWING_LEFT.,.T.,$);";
    let out = convert_step_line(line, "IFC4", "IFC2X3", 1, &mut none(), None).unwrap();

    assert!(!out.contains("IFCPROXY"), "must not fall back to a proxy: {out}");
    assert!(out.starts_with("#1=IFCDOORSTYLE("), "renamed to IfcDoorStyle: {out}");
    // GlobalId, Name, HasPropertySets, RepresentationMaps, Tag all survive.
    assert!(out.contains("'1mW6gHB0W7lxCAqIKVEzia'"), "GlobalId preserved: {out}");
    assert!(out.contains("'Türtyp Größe'"), "Name preserved byte for byte: {out}");
    assert!(out.contains("(#3)"), "HasPropertySets preserved: {out}");
    assert!(out.contains("(#4)"), "RepresentationMaps preserved: {out}");
    assert!(out.contains("'tag'"), "Tag preserved: {out}");
    // IfcDoorStyle(IFC2X3) attrs: GlobalId,OwnerHistory,Name,Description,
    // ApplicableOccurrence,HasPropertySets,RepresentationMaps,Tag,
    // OperationType,ConstructionType,ParameterTakesPrecedence,Sizeable.
    // ConstructionType and Sizeable are mandatory in IFC2X3 and have no
    // IFC4 source, so they carry the schema's default, not `$`.
    assert_eq!(
        out,
        "#1=IFCDOORSTYLE('1mW6gHB0W7lxCAqIKVEzia',#2,'Türtyp Größe',$,$,(#3),(#4),'tag',\
         .SINGLE_SWING_LEFT.,.NOTDEFINED.,.T.,.F.);"
    );
}

/// The IFC4 to IFC2X3 door/window remap used to write `$` into every target
/// slot with no same-named source attribute, and two of those slots are
/// mandatory in IFC2X3 (`IfcDoorStyle.ConstructionType`, an enum, and
/// `.Sizeable`, a BOOLEAN), so the downgraded record was one a strict Part 21
/// reader rejects. The same applies to `ParameterTakesPrecedence`, optional
/// in IFC4 and mandatory in IFC2X3, when the source left it `$`. Optional
/// target slots keep `$`.
#[test]
fn door_and_window_downgrade_fill_mandatory_ifc2x3_slots_instead_of_dollar() {
    // ParameterTakesPrecedence (IFC4 index 11) is `$` here.
    let door = "#1=IFCDOORTYPE('0DOORTYPE00000000000A',$,'DT',$,$,$,$,'tag',$,.DOOR.,\
                .SINGLE_SWING_LEFT.,$,$);";
    assert_eq!(
        convert_step_line(door, "IFC4", "IFC2X3", 1, &mut none(), None).unwrap(),
        "#1=IFCDOORSTYLE('0DOORTYPE00000000000A',$,'DT',$,$,$,$,'tag',\
         .SINGLE_SWING_LEFT.,.NOTDEFINED.,.F.,.F.);"
    );
    // IfcWindowStyle(IFC2X3): ...,Tag,ConstructionType,OperationType,
    // ParameterTakesPrecedence,Sizeable. IFC4's PartitioningType has no
    // target slot (dropped); OperationType has no source and is mandatory.
    let window = "#2=IFCWINDOWTYPE('0WINDOWTYPE000000000A',$,'WT',$,$,$,$,'tag',$,.WINDOW.,\
                  .SINGLE_PANEL.,.T.,$);";
    assert_eq!(
        convert_step_line(window, "IFC4", "IFC2X3", 2, &mut none(), None).unwrap(),
        "#2=IFCWINDOWSTYLE('0WINDOWTYPE000000000A',$,'WT',$,$,$,$,'tag',\
         .NOTDEFINED.,.NOTDEFINED.,.T.,.F.);"
    );
    // Control: the optional slots (Description, ApplicableOccurrence, ...)
    // are still `$`, so this is a mandatory-slot rule and not a blanket fill.
    let out = convert_step_line(door, "IFC4", "IFC2X3", 1, &mut none(), None).unwrap();
    assert!(out.contains("'DT',$,$,$,$,'tag'"), "optional slots stay `$`: {out}");
    // A writer that puts a space after each comma: the splitter keeps the
    // padding, so the empty slot reads ` $`, and it is still the placeholder
    // (the TypeScript twin's splitter trims, and fills it).
    let spaced = "#3=IFCDOORTYPE('0DOORTYPE00000000000B',$,'DT',$,$,$,$,'tag',$,.DOOR.,\
                  .SINGLE_SWING_LEFT., $, $);";
    let out = convert_step_line(spaced, "IFC4", "IFC2X3", 3, &mut none(), None).unwrap();
    assert!(out.ends_with(",.F.,.F.);"), "a padded `$` in a mandatory slot is filled: {out}");
}

#[test]
fn ifcwindowtype_maps_to_ifcwindowstyle_preserving_globalid_and_name() {
    // IfcWindowType(IFC4) attrs: …,Tag,ElementType,PredefinedType,
    // PartitioningType,ParameterTakesPrecedence,UserDefinedPartitioningType
    let line = "#1=IFCWINDOWTYPE('3Vnz8SzMO$_GklsTTZo$zj',#2,'Window Type',$,$,$,$,'tag',\
                $,.WINDOW.,.SINGLE_PANEL.,.T.,$);";
    let out = convert_step_line(line, "IFC4", "IFC2X3", 1, &mut none(), None).unwrap();

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
    let out = convert_step_line(line, "IFC2X3", "IFC4", 1, &mut none(), None).unwrap();
    assert_eq!(out, line, "upgrade leg is untouched: {out}");
}

#[test]
fn other_ifc2x3_downgrade_renames_still_use_positional_trim() {
    // Control: the by-name remap is scoped to exactly IFCDOORTYPE/
    // IFCWINDOWTYPE, not applied to every IFC4->IFC2X3 rename.
    let line = "#5=IFCCHIMNEY('g',$,'C1',$,$,#6,#7,'tag',.USERDEFINED.);";
    let out = convert_step_line(line, "IFC4", "IFC2X3", 5, &mut none(), None).unwrap();
    assert!(out.starts_with("#5=IFCBUILDINGELEMENTPROXY("), "renamed via positional path: {out}");
    // IfcBuildingElementProxy caps at 9 IFC2X3 attrs; this line has exactly 9, so nothing trims.
    assert!(out.contains(".USERDEFINED."), "positional trim/pass-through unaffected: {out}");
}

#[test]
fn schema_conversion_preserves_utf8_through_the_shared_slot_parser() {
    let line = "#5=IFCCHIMNEY('g',$,'Größe',$,$,#6,#7,'tag',.USERDEFINED.,$);";
    let out = convert_step_line(line, "IFC4", "IFC2X3", 5, &mut none(), None).unwrap();
    assert!(out.contains("'Größe'"), "UTF-8 text must remain byte-correct: {out}");
}

#[test]
fn schema_conversion_refuses_a_malformed_positional_split() {
    let line = "#1=IFCDOORTYPE('g',\"01,23\",$,$,$,$,$,$,$,$,$,$,$);";
    assert_eq!(convert_step_line(line, "IFC4", "IFC2X3", 1, &mut none(), None).unwrap(), line);
}

#[test]
fn schema_conversion_refuses_before_type_rename_or_proxy_replacement() {
    let rename = "#10=IFCBRIDGE('g',\"01,23\",$);";
    assert_eq!(convert_step_line(rename, "IFC4X3", "IFC4", 10, &mut none(), None).unwrap(), rename);

    let proxy = "#99=IFCALIGNMENTCANT('g',\"01,23\",$);";
    assert_eq!(convert_step_line(proxy, "IFC4X3", "IFC4", 99, &mut none(), None).unwrap(), proxy);
}

/// LTplus-AG/ifc-lite#4200: the deleted `split_top_level` rebuilt each
/// attribute with `bytes[i] as char`, re-encoding UTF-8 continuation bytes as
/// Latin-1, and it fired on the UNTRIMMED branch too (`trim_attributes` joined
/// the parts back unconditionally). #4584's tests cover the trimmed and
/// by-name branches; this pins the untrimmed one (eight attributes, IFCWALL's
/// IFC2X3 cap), byte for byte.
#[test]
fn ifc2x3_downgrade_keeps_an_untrimmed_non_ascii_line_byte_for_byte() {
    let untrimmed = "#1=IFCWALL('0abc',$,'Größe Wand',$,$,$,$,$);";
    assert_eq!(convert_step_line(untrimmed, "IFC4", "IFC2X3", 1, &mut none(), None).unwrap(), untrimmed);
}

/// The same defect measured where a user meets it: `export_step` with an
/// explicit IFC2X3 target, end to end over a whole file. The file carries an
/// owner history, so the `$` OwnerHistory slot IFC2X3 requires is filled from
/// it (#4686); this used to pin `$` there, an invalid IFC2X3 record.
#[test]
fn export_step_ifc2x3_downgrade_does_not_mojibake_a_name() {
    let src = step_file(
        "IFC4",
        "#1=IFCWALL('0abcdefghijklmnopqrstu',$,'Größe Wand',$,$,$,$,$,.SOLIDWALL.);\n\
         #9=IFCOWNERHISTORY(#7,#8,$,.NOCHANGE.,$,$,$,0);",
    );
    let out = downgrade(&src).0;
    assert!(
        out.contains("#1=IFCWALL('0abcdefghijklmnopqrstu',#9,'Größe Wand',$,$,$,$,$);"),
        "{out}"
    );
}

fn step_file(schema: &str, data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('a.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('{schema}'));\nENDSEC;\n\
         DATA;\n{data}\nENDSEC;\nEND-ISO-10303-21;\n"
    )
}

fn downgrade(src: &str) -> (String, crate::StepStats) {
    crate::export_step_with_stats(
        src.as_bytes(),
        &crate::StepOptions { schema: Some("IFC2X3".to_string()), ..Default::default() },
    )
    .unwrap()
}

fn line_with_id<'a>(out: &'a str, id: &str) -> &'a str {
    let prefix = format!("{id}=");
    out.lines().find(|l| l.starts_with(&prefix)).unwrap_or_else(|| panic!("{id} in {out}"))
}

fn slot(line: &str, index: usize) -> String {
    let open = line.find('(').unwrap() + 1;
    let close = line.rfind(')').unwrap();
    crate::step_slot::split_top_level_args(&line[open..close]).unwrap()[index].clone()
}

/// #4686: IfcRoot.OwnerHistory is optional in IFC4 and mandatory in IFC2X3.
/// The shared vectors (reuse the first owner history, keep `$` and count it
/// when there is none, the IFCPROXY placeholder, the by-name door remap) run
/// through this exporter here and through `StepExporter` in
/// `packages/export/src/schema-converter-owner-history.test.ts`.
#[test]
fn ifc2x3_owner_history_fill_matches_the_shared_vectors() {
    let raw = include_str!("../tests/fixtures/ifc2x3_owner_history_vectors.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    let cases = doc["cases"].as_array().expect("cases");
    assert!(cases.len() >= 5, "the vector file lost cases");
    for case in cases {
        let why = case["why"].as_str().unwrap();
        let data: Vec<&str> = case["data"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
        let (out, stats) = downgrade(&step_file(case["schema"].as_str().unwrap(), &data.join("\n")));
        for (id, want) in case["owner_history"].as_object().unwrap() {
            let line = line_with_id(&out, &format!("#{id}"));
            assert_eq!(slot(line, 1), want.as_str().unwrap(), "{why}: {line}");
        }
        assert_eq!(stats.owner_history_unfilled as u64, case["unfilled"].as_u64().unwrap(), "{why}\n{out}");
    }
}

/// #4686: the owner history is found by its keyword in any case, as a STEP
/// keyword is case-insensitive. Rust-only: the TypeScript parser does not
/// index a record whose keyword is not upper case, so there is no shared
/// vector for it.
#[test]
fn ifc2x3_downgrade_finds_an_owner_history_written_in_lower_case() {
    let src = step_file(
        "IFC4",
        "#10=IFCWALL('2O2Fr$t4X7Zf8NOew3FLOH',$,'Wall',$,$,$,$,$,$);\n\
         #5=ifcOwnerHistory($,$,$,.NOCHANGE.,$,$,$,0);\n\
         #6=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);",
    );
    let (out, stats) = downgrade(&src);
    assert_eq!(slot(line_with_id(&out, "#10"), 1), "#5", "{out}");
    assert_eq!(stats.owner_history_unfilled, 0);
}

/// #4686: a subset export writes only what its roots reach. An owner history
/// nothing included names is not written, so pointing at it would dangle; the
/// slot stays `$` and is counted instead.
#[test]
fn ifc2x3_subset_downgrade_never_points_at_an_owner_history_it_does_not_write() {
    let src = step_file(
        "IFC4",
        "#5=IFCOWNERHISTORY(#1,#2,$,.NOCHANGE.,$,$,$,0);\n\
         #10=IFCWALL('2O2Fr$t4X7Zf8NOew3FLOH',$,'Wall',$,$,$,$,$,$);",
    );
    let (out, stats) = crate::export_step_with_stats(
        src.as_bytes(),
        &crate::StepOptions {
            schema: Some("IFC2X3".to_string()),
            included: Some(vec![10]),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!out.contains("#5="), "{out}");
    assert_eq!(slot(line_with_id(&out, "#10"), 1), "$");
    assert_eq!(stats.owner_history_unfilled, 1);
}

/// #4686: an upgrade, and a downgrade that stops at IFC4, are left alone:
/// OwnerHistory is optional there.
#[test]
fn owner_history_fill_only_applies_to_an_ifc2x3_target() {
    let mut fill = Ifc2x3SlotFill::new(Some(9));
    let wall = "#2=IFCWALL('2abcdefghijklmnopqrstu',$,'W',$,$,$,$,$);";
    assert_eq!(slot(&convert_step_line(wall, "IFC2X3", "IFC4", 2, &mut fill, None).unwrap(), 1), "$");
    let bridge = "#3=IFCBRIDGE('3abcdefghijklmnopqrstu',$,'B',$,$,$,$,$,$,$,$);";
    assert_eq!(slot(&convert_step_line(bridge, "IFC4X3", "IFC4", 3, &mut fill, None).unwrap(), 1), "$");
    assert_eq!(fill.owner_history_unfilled(), 0);
}

/// #4686, merged export: a later model without an owner history of its own
/// reuses the one an earlier model wrote. With none in any model the merge
/// says so in `warnings`.
#[test]
fn merged_ifc2x3_downgrade_reuses_an_owner_history_across_models() {
    let a = step_file(
        "IFC4",
        "#1=IFCOWNERHISTORY(#8,#9,$,.NOCHANGE.,$,$,$,0);\n\
         #2=IFCWALL('1abcdefghijklmnopqrstu',$,'A',$,$,$,$,$,$);",
    );
    let b = step_file("IFC4", "#1=IFCWALL('2abcdefghijklmnopqrstu',$,'B',$,$,$,$,$,$);");
    let opts = crate::MergedOptions { schema: Some("IFC2X3".to_string()), ..Default::default() };
    let (out, stats) = crate::export_merged_with_stats(&[a.as_bytes(), b.as_bytes()], &opts);
    let history = out.lines().find(|l| l.contains("IFCOWNERHISTORY(")).expect("owner history written");
    let history_ref = &history[..history.find('=').unwrap()];
    for name in ["'A'", "'B'"] {
        let wall = out.lines().find(|l| l.contains(name)).unwrap_or_else(|| panic!("{name} in {out}"));
        assert_eq!(slot(wall, 1), history_ref, "{wall}");
    }
    assert!(stats.warnings.iter().all(|w| !w.contains("OwnerHistory")), "{:?}", stats.warnings);

    let (out, stats) = crate::export_merged_with_stats(&[b.as_bytes()], &opts);
    let wall = out.lines().find(|l| l.contains("'B'")).unwrap_or_else(|| panic!("{out}"));
    assert_eq!(slot(wall, 1), "$");
    assert!(
        stats.warnings.iter().any(|w| w.starts_with("1 record(s) keep $ in OwnerHistory")),
        "{:?}",
        stats.warnings
    );
}

/// #4714: IFC4 made attributes optional that IFC2X3 declares mandatory. The
/// shared vectors (an enum with `NOTDEFINED` and a BOOLEAN taking the values
/// that claim nothing, an enum without one keeping `$`, required references
/// never invented, `IfcOwnerHistory`'s own `ChangeAction`, the by-name door
/// remap) run through this exporter here and through `StepExporter` in
/// `packages/export/src/schema-converter-required-slots.test.ts`.
#[test]
fn ifc2x3_required_slot_fill_matches_the_shared_vectors() {
    let raw = include_str!("../tests/fixtures/ifc2x3_required_slot_vectors.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    let cases = doc["cases"].as_array().expect("cases");
    assert!(cases.len() >= 5, "the vector file lost cases");
    for case in cases {
        let why = case["why"].as_str().unwrap();
        let data: Vec<&str> = case["data"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
        let (out, stats) = downgrade(&step_file(case["schema"].as_str().unwrap(), &data.join("\n")));
        for (id, want_slots) in case["slots"].as_object().unwrap() {
            let line = line_with_id(&out, &format!("#{id}"));
            for (index, want) in want_slots.as_object().unwrap() {
                let index: usize = index.parse().expect("slot index");
                assert_eq!(slot(line, index), want.as_str().unwrap(), "{why}: slot {index} of {line}");
            }
        }
        assert_eq!(
            stats.required_slots_unfilled as u64,
            case["unfilled"].as_u64().unwrap(),
            "{why}\n{out}"
        );
    }
}

/// #4714: the table's indexes are positions in the IFC2X3 attribute list, so a
/// record that does not carry that many slots was never reconciled to it.
/// Filling slot 8 of an 8-slot IfcFooting would write `.NOTDEFINED.` over
/// whatever position 8 does hold, so the record is left alone -- and NOT
/// counted, because nothing about its required slots was established.
#[test]
fn ifc2x3_required_slot_fill_refuses_a_record_of_the_wrong_arity() {
    let src = step_file(
        "IFC4",
        "#10=IFCFOOTING('2O2Fr$t4X7Zf8NOew3FLOH',$,'F',$,$,$,$,$);\n\
         #11=IFCFOOTING('3O2Fr$t4X7Zf8NOew3FLOH',$,'F',$,$,$,$,$,$);",
    );
    let (out, stats) = downgrade(&src);
    let short = line_with_id(&out, "#10");
    assert_eq!(short.matches(',').count(), 7, "left at 8 slots: {short}");
    assert!(!short.contains(".NOTDEFINED."), "nothing written into it: {short}");
    // The well-formed sibling still gets its PredefinedType, so the refusal is
    // the arity and not the fill being off.
    assert_eq!(slot(line_with_id(&out, "#11"), 8), ".NOTDEFINED.");
    assert_eq!(stats.required_slots_unfilled, 0, "{out}");
}

/// #4714: IFC4 and IFC4X3 declare these slots optional, so a target that is
/// not IFC2X3 keeps whatever the source wrote and counts nothing.
#[test]
fn required_slot_fill_only_applies_to_an_ifc2x3_target() {
    let mut fill = Ifc2x3SlotFill::new(None);
    let footing = "#10=IFCFOOTING('2O2Fr$t4X7Zf8NOew3FLOH',$,'F',$,$,$,$,$,$);";
    let out = convert_step_line(footing, "IFC2X3", "IFC4", 10, &mut fill, None).unwrap();
    assert_eq!(slot(&out, 8), "$", "{out}");
    assert_eq!(fill.required_slots_unfilled(), 0);
}

/// #4714: the property sets this exporter SYNTHESIZES from `property_mutations`
/// are built after the emit loop and never reach `convert_step_line`, so they
/// used to go out with `$` in `OwnerHistory` -- which IFC2X3 requires -- even
/// when the file had an owner history to point them at. They are filled
/// whenever the OUTPUT is IFC2X3, including when the source already is and no
/// conversion runs at all.
#[test]
fn ifc2x3_synthesized_property_sets_name_an_owner_history() {
    for source_schema in ["IFC4", "IFC2X3"] {
        let src = step_file(
            source_schema,
            "#5=IFCOWNERHISTORY(#6,#7,$,.NOCHANGE.,$,$,$,0);\n\
             #10=IFCWALL('2O2Fr$t4X7Zf8NOew3FLOH',#5,'Wall',$,$,$,$,$);",
        );
        let (out, _) = crate::export_step_with_stats(
            src.as_bytes(),
            &crate::StepOptions {
                schema: Some("IFC2X3".to_string()),
                property_mutations: vec![crate::PropMutation {
                    express_id: 10,
                    pset_name: "Pset_Test".to_string(),
                    prop_name: "IsExternal".to_string(),
                    value: "IFCBOOLEAN(.T.)".to_string(),
                }],
                ..Default::default()
            },
        )
        .unwrap();
        let pset = out.lines().find(|l| l.contains("IFCPROPERTYSET(")).unwrap_or_else(|| panic!("{out}"));
        assert_eq!(slot(pset, 1), "#5", "{source_schema}: {pset}");
        let rel = out.lines().find(|l| l.contains("IFCRELDEFINESBYPROPERTIES(")).unwrap_or_else(|| panic!("{out}"));
        assert_eq!(slot(rel, 1), "#5", "{source_schema}: {rel}");
    }
}

/// #4714, merged export: the required-slot count reaches the caller through
/// the `warnings` channel the merge already had.
#[test]
fn merged_ifc2x3_downgrade_warns_about_required_slots_it_left() {
    let model = step_file(
        "IFC4",
        "#1=IFCOWNERHISTORY(#8,#9,$,.NOCHANGE.,$,$,$,0);\n\
         #2=IFCBUILDINGSTOREY('1abcdefghijklmnopqrstu',$,'S',$,$,$,$,$,$,$);",
    );
    let opts = crate::MergedOptions { schema: Some("IFC2X3".to_string()), ..Default::default() };
    let (out, stats) = crate::export_merged_with_stats(&[model.as_bytes()], &opts);
    let storey = out.lines().find(|l| l.contains("'S'")).unwrap_or_else(|| panic!("{out}"));
    assert_eq!(slot(storey, 8), "$", "CompositionType has no NOTDEFINED member: {storey}");
    assert!(
        stats.warnings.iter().any(|w| w.starts_with("1 slot(s) keep $ where IFC2X3 requires")),
        "{:?}",
        stats.warnings
    );
}

/// #5116: `export_merged` has no fallible signature, so a non-rooted type
/// with no IFC2X3 representation (common real-world input -- any IFC4 model
/// with tessellated geometry) must NOT panic there the way the single-model
/// `convert_step_line` now errs. This is the regression guard for that: the
/// merge keeps the record unconverted (same as pre-#5116 behavior for this
/// one case) and reports it in `warnings`, rather than aborting the whole
/// export (unrecoverable through the wasm ABI -- no unwinding).
#[test]
fn merged_ifc2x3_downgrade_keeps_an_unrepresented_type_instead_of_panicking() {
    let model = step_file(
        "IFC4",
        "#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));",
    );
    let opts = crate::MergedOptions { schema: Some("IFC2X3".to_string()), ..Default::default() };
    let (out, stats) = crate::export_merged_with_stats(&[model.as_bytes()], &opts);
    assert!(out.contains("IFCCARTESIANPOINTLIST3D("), "kept unconverted: {out}");
    assert!(
        stats.warnings.iter().any(|w| w.contains("IFCCARTESIANPOINTLIST3D") && w.contains("#5116")),
        "{:?}",
        stats.warnings
    );
}

/// #4206: the TS twin's `schema-converter-structural.test.ts`, ported. IFC4
/// left `IFCSTRUCTURALLOADCASE`/`IFCSTRUCTURALCURVEACTION`/
/// `IFCSTRUCTURALSURFACEACTION` unmapped in `map_4_to_2x3`, so every one fell
/// through to the proxy branch -- losing the GlobalId, the applied-load
/// reference and the load/action classification -- even though IFC2X3 has a
/// real target for each. Input lines use the same attribute VALUES as the
/// TS test, taken from the real Constructivity export
/// `tests/models/ifcopenshell/structural_analysis_curve.ifc` (express ids
/// #312, #317), so a divergence between the two "twin" implementations on
/// the project's own canonical fixture would show up here.
#[test]
fn ifcstructuralloadcase_trims_to_ifcstructuralloadgroup() {
    let line = "#312=IFCSTRUCTURALLOADCASE('2fv4DZfY55exwX8QDy8dmw',#209,'Structural Load Case #1',$,$,\
                .LOAD_CASE.,.NOTDEFINED.,.NOTDEFINED.,1.,$,(0.,0.,0.));";
    let out = convert_step_line(line, "IFC4", "IFC2X3", 312, &mut none(), None).unwrap();
    assert!(!out.contains("IFCPROXY"), "must not fall back to a proxy: {out}");
    assert_eq!(
        out,
        "#312=IFCSTRUCTURALLOADGROUP('2fv4DZfY55exwX8QDy8dmw',#209,'Structural Load Case #1',$,$,\
         .LOAD_CASE.,.NOTDEFINED.,.NOTDEFINED.,1.,$);"
    );
}

#[test]
fn ifcstructuralcurveaction_maps_to_ifcstructurallinearaction() {
    let line = "#317=IFCSTRUCTURALCURVEACTION('2WSwGyLsrFNA9TLOq_ifyd',#209,'Structural Curve Action #1',\
                $,$,$,$,#326,.GLOBAL_COORDS.,.F.,$,.LINEAR.);";
    let out = convert_step_line(line, "IFC4", "IFC2X3", 317, &mut none(), None).unwrap();
    assert!(!out.contains("IFCPROXY"), "must not fall back to a proxy: {out}");
    // AppliedLoad (#326) and GlobalOrLocal/DestabilizingLoad survive by
    // name; PredefinedType (.LINEAR., IFC4-only) has no IFC2X3 slot and is
    // dropped; CausedBy (IFC2X3-only, optional) has no IFC4 source and
    // stays `$`.
    assert_eq!(
        out,
        "#317=IFCSTRUCTURALLINEARACTION('2WSwGyLsrFNA9TLOq_ifyd',#209,'Structural Curve Action #1',\
         $,$,$,$,#326,.GLOBAL_COORDS.,.F.,$,$);"
    );
}

/// #5116: IFC2X3 genuinely never defined a curve/surface reaction entity
/// (only `IfcStructuralPointReaction`), same as TS. Before #5116 this crate
/// had NO fallback for a type with no target representation at all -- the
/// line passed through UNCHANGED under its IFC4-only type name, producing a
/// line that is not valid IFC2X3 (pinned by this test's previous version,
/// `ifcstructuralcurvereaction_passes_through_unchanged_not_a_proxy_pre_existing_rust_gap`).
/// `IfcStructuralCurveReaction` is an `IfcProduct` (rooted), so it now gets
/// the same `IFCPROXY` fallback the TS twin's `resolveUnrepresentedEntity`
/// already gave it, via `schema_unrepresented::resolve_unrepresented_entity`.
#[test]
fn ifcstructuralcurvereaction_becomes_a_proxy_no_representation_in_ifc2x3() {
    let line = "#2773=IFCSTRUCTURALCURVEREACTION('0SH7YcIWrB8Q4VcWjfXpnn',#209,$,$,$,$,$,#2772,\
                .GLOBAL_COORDS.,.DISCRETE.);";
    let out = convert_step_line(line, "IFC4", "IFC2X3", 2773, &mut none(), None).unwrap();
    assert!(out.starts_with("#2773=IFCPROXY("), "no IFC2X3 representation -> proxy: {out}");
    assert!(out.contains("'IFCSTRUCTURALCURVEREACTION'"), "original type recorded as name: {out}");
    assert!(!out.contains("#2772"), "the dropped AppliedLoad reference must not survive: {out}");
}

/// #5116: the general "no representation" fallback errs (rather than
/// silently passing through) for a NON-rooted type with no IFC2X3
/// representation -- `IfcCartesianPointList3D` is a representation
/// resource, referenced positionally, so it cannot become an `IFCPROXY`
/// (an `IfcProduct`) either. Mirrors the TS twin's
/// `schema-converter-untranslatable.test.ts`.
#[test]
fn non_rooted_type_with_no_ifc2x3_representation_errors_instead_of_passing_through() {
    let line = "#101=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));";
    let err = convert_step_line(line, "IFC4", "IFC2X3", 101, &mut none(), None).unwrap_err();
    assert_eq!(err.express_id, 101);
    assert!(err.to_string().contains("IFCCARTESIANPOINTLIST3D"));
}

/// #5116, control: a type WITH a rename entry (so it has a real IFC2X3
/// target under its RENAMED name) must not be caught by the new "no
/// representation" check just because its ORIGINAL name is absent from
/// `IFC2X3_ENTITY_NAMES` -- the check runs on `new_type`, the post-rename
/// name, same as the TypeScript twin's `attrNameTable(toSchema).get(newType)`.
#[test]
fn a_renamed_type_is_not_treated_as_unrepresented() {
    let line = "#1=IFCBURNERTYPE('g',$,$);";
    let out = convert_step_line(line, "IFC4", "IFC2X3", 1, &mut none(), None).unwrap();
    assert!(!out.contains("IFCPROXY"), "renamed to IFCGASTERMINALTYPE, not unrepresented: {out}");
    assert!(out.starts_with("#1=IFCGASTERMINALTYPE("), "{out}");
}

/// #5307 (Rust twin of #5202's finding 2). `IfcProjectedCRS.Name` is optional
/// in IFC4X3/IFC5 but mandatory in IFC4. The `$` stays (a label is never
/// invented) and is counted.
#[test]
fn ifc4x3_to_ifc4_downgrade_counts_an_unfillable_mandatory_slot() {
    let line = "#10=IFCPROJECTEDCRS($,'A description',$,$,$,$,$);";
    let mut check = crate::schema_ifc4_slots::Ifc4SlotCheck::new();
    let out = convert_step_line(line, "IFC4X3", "IFC4", 10, &mut none(), Some(&mut check)).unwrap();
    assert_eq!(out, line, "no value is fabricated: {out}");
    assert_eq!(check.required_slots_unfilled(), 1);
    assert!(check.warnings()[0].contains("not valid IFC4"), "{:?}", check.warnings());
}

/// #5307: a BOOLEAN flag is counted, never filled. `SameSense` is required in
/// IFC4X3 as well, and `.F.` would reverse the segment (review of #5341, the
/// same finding that removed the fill from the TypeScript twin in #5347).
#[test]
fn ifc4x3_to_ifc4_downgrade_never_fills_a_boolean_flag() {
    let line = "#5=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,$,#6);";
    let mut check = crate::schema_ifc4_slots::Ifc4SlotCheck::new();
    let out = convert_step_line(line, "IFC5", "IFC4", 5, &mut none(), Some(&mut check)).unwrap();
    assert_eq!(out, line, "SameSense keeps its $: {out}");
    assert_eq!(check.required_slots_unfilled(), 1);
}

/// #5307 control: `IFC2X3 -> IFC4` is excluded, the scope line #5202 drew.
#[test]
fn ifc2x3_to_ifc4_upgrade_is_not_counted() {
    let line = "#5=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,$,#6);";
    let mut check = crate::schema_ifc4_slots::Ifc4SlotCheck::new();
    let out = convert_step_line(line, "IFC2X3", "IFC4", 5, &mut none(), Some(&mut check)).unwrap();
    assert_eq!(out, line, "{out}");
    assert_eq!(check.required_slots_unfilled(), 0);
}

/// #5307: a record whose arity is not IFC4's is not counted: position `i` need
/// not be attribute `i`.
#[test]
fn ifc4x3_to_ifc4_downgrade_skips_a_record_whose_arity_disagrees_with_the_table() {
    let line = "#5=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,$);"; // 2 attrs, table expects 3
    let mut check = crate::schema_ifc4_slots::Ifc4SlotCheck::new();
    let out = convert_step_line(line, "IFC4X3", "IFC4", 5, &mut none(), Some(&mut check)).unwrap();
    assert_eq!(out, line, "{out}");
    assert_eq!(check.required_slots_unfilled(), 0);
}
