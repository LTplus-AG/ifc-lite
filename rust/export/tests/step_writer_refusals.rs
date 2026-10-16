// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7682: what the STEP writers refuse rather than write wrong, and count so a
//! caller learns an edit is missing (EXPORT-STEP-9/10/11/26). The plain writer
//! (`export_step_with_stats`) reports through `StepStats`; the mutation-log
//! writer (`export_step_with_log`) through its warnings, its counters, or a
//! refusal of the whole export.

use ifc_lite_core::{EntityDecoder, EntityScanner};
use ifc_lite_export::{
    export_step_with_log, export_step_with_stats, AttrMutation, CopyOnWriteMutation, MutationLog, PropMutation,
    StepOptions,
};

fn file(records: &[&str]) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        records.join("\n")
    )
}

const WALL: &str = "#1=IFCWALL('3nZ2y9nY9FExK3Wg9nLvXz',$,'Wall',$,$,$,$,$,$);";
const TOP_WALL: &str = "#4294967295=IFCWALL('0uK8j9R5T5E8Gf7Ybq5ZpA',$,'Top',$,$,$,$,$,$);";

fn prop(id: u32, name: &str, value: &str) -> PropMutation {
    PropMutation { express_id: id, pset_name: "Pset_X".into(), prop_name: name.into(), value: value.into() }
}

/// Every `#id=` in `out`, in order.
fn ids(out: &str) -> Vec<u64> {
    out.lines().filter_map(|l| l.strip_prefix('#')?.split_once('=')?.0.parse().ok()).collect()
}

/// The records core's scanner reads out of `out`: what any ifc-lite reader of
/// the written file would see.
fn scanned(out: &str) -> Vec<(u32, String)> {
    let mut scanner = EntityScanner::new(out.as_bytes());
    let mut records = Vec::new();
    while let Some((id, ty, _, _)) = scanner.next_entity() {
        records.push((id, ty.to_string()));
    }
    records
}

/// EXPORT-STEP-10: each way the plain writer drops a property mutation is
/// counted, per mutation.
#[test]
fn property_mutations_the_writer_cannot_place_are_counted_7682() {
    // Not in the export (`included` holds only #1, and #2 is not reachable).
    let source = file(&[WALL, "#2=IFCWALL('1hA2b3C4d5E6f7G8h9I0jK',$,'Other',$,$,$,$,$,$);"]);
    let opts = StepOptions {
        included: Some(vec![1]),
        property_mutations: vec![prop(2, "A", "IFCLABEL('x')"), prop(1, "B", "IFCLABEL('y')")],
        ..StepOptions::default()
    };
    let (out, stats) = export_step_with_stats(source.as_bytes(), &opts).unwrap();
    assert_eq!(stats.property_mutations_refused, 1);
    assert!(out.contains("IFCLABEL('y')") && !out.contains("IFCLABEL('x')"), "{out}");

    // No id left at all: the file already holds `u32::MAX`.
    let source = file(&[WALL, TOP_WALL]);
    let opts = StepOptions { property_mutations: vec![prop(1, "A", "IFCLABEL('x')")], ..StepOptions::default() };
    let (out, stats) = export_step_with_stats(source.as_bytes(), &opts).unwrap();
    assert_eq!(stats.property_mutations_refused, 1);
    assert!(!out.contains("IFCPROPERTYSET"), "{out}");

    // A group that does not fit the ids left is refused whole: two
    // properties need four ids, three are left.
    let source = file(&[WALL, "#4294967292=IFCWALL('0uK8j9R5T5E8Gf7Ybq5ZpA',$,'Top',$,$,$,$,$,$);"]);
    let opts = StepOptions {
        property_mutations: vec![prop(1, "A", "IFCLABEL('x')"), prop(1, "B", "IFCLABEL('y')")],
        ..StepOptions::default()
    };
    let (out, stats) = export_step_with_stats(source.as_bytes(), &opts).unwrap();
    assert_eq!(stats.property_mutations_refused, 2);
    assert!(!out.contains("IFCPROPERTYSINGLEVALUE"), "nothing half-written: {out}");
}

/// EXPORT-STEP-26: a caller-supplied value is written as is, so one that is
/// not ONE STEP value is refused and counted instead of shifting slots or
/// writing records the caller never asked for.
#[test]
fn values_that_are_not_one_step_value_are_refused_7682() {
    let source = file(&[WALL]);
    let opts = StepOptions {
        attribute_mutations: vec![
            AttrMutation { express_id: 1, index: 2, value: "'a','b'".into() },
            AttrMutation { express_id: 1, index: 3, value: "'x');\n#9=IFCWALL('y'".into() },
            AttrMutation { express_id: 1, index: 4, value: String::new() },
            AttrMutation { express_id: 1, index: 7, value: "'TAG'".into() },
        ],
        property_mutations: vec![prop(1, "A", "IFCLABEL('x'));\n#9=IFCWALL(("), prop(1, "B", "1,2")],
        ..StepOptions::default()
    };
    let (out, stats) = export_step_with_stats(source.as_bytes(), &opts).unwrap();
    assert_eq!(stats.attribute_edits_refused, 3);
    assert_eq!(stats.property_mutations_refused, 2);
    assert!(out.contains("#1=IFCWALL('3nZ2y9nY9FExK3Wg9nLvXz',$,'Wall',$,$,$,$,'TAG',$);"), "{out}");
    assert_eq!(ids(&out), vec![1], "no record the caller did not create: {out}");

    // #7715 review: an UNTERMINATED comment is a well-formed trailing slot for
    // a source record, but a caller value that opens one swallows the rest of
    // the record, and a later value can close it and inject a record. A
    // caller value holding `/*` anywhere is refused.
    let opts = StepOptions {
        attribute_mutations: vec![AttrMutation { express_id: 1, index: 2, value: "'x' /*".into() }],
        property_mutations: vec![
            prop(1, "A", "IFCLABEL('x') /*"),
            prop(1, "B", "IFCLABEL('*/);\n#99=IFCFOO(1);/*')"),
            prop(1, "C", "IFCLABEL('ok')"),
        ],
        ..StepOptions::default()
    };
    let (out, stats) = export_step_with_stats(source.as_bytes(), &opts).unwrap();
    assert_eq!(stats.attribute_edits_refused, 1);
    assert_eq!(stats.property_mutations_refused, 2);
    let records = scanned(&out);
    assert_eq!(
        records.iter().map(|(id, ty)| (*id, ty.as_str())).collect::<Vec<_>>(),
        vec![(1, "IFCWALL"), (2, "IFCPROPERTYSINGLEVALUE"), (3, "IFCPROPERTYSET"), (4, "IFCRELDEFINESBYPROPERTIES")],
        "every written record is read back, and none the caller did not create: {out}"
    );

    // #7715 review, round 2: a binary literal ends at the next `"` for the
    // slot grammar, but core's scanner has no binary-literal rule and reads a
    // `'` inside one as a string, so a caller value could close the record. A
    // binary literal is held to `"[0-3][0-9A-F]*"`; one that is hex is kept.
    let breakout = "\"0'X');\n#99=IFCFOO(1);\n#100=IFCFOO(Y\"";
    let opts = StepOptions {
        attribute_mutations: vec![AttrMutation { express_id: 1, index: 2, value: breakout.into() }],
        property_mutations: vec![
            prop(1, "A", breakout),
            prop(1, "B", &format!("IFCBINARY({breakout})")),
            prop(1, "C", "IFCBINARY(\"x\")"),
            prop(1, "D", "IFCBINARY(\"21A\")"),
        ],
        ..StepOptions::default()
    };
    let (out, stats) = export_step_with_stats(source.as_bytes(), &opts).unwrap();
    assert_eq!(stats.attribute_edits_refused, 1);
    assert_eq!(stats.property_mutations_refused, 3);
    assert!(out.contains("IFCBINARY(\"21A\")"), "a hex binary literal is written: {out}");
    let records = scanned(&out);
    assert_eq!(
        records.iter().map(|(id, ty)| (*id, ty.as_str())).collect::<Vec<_>>(),
        vec![(1, "IFCWALL"), (2, "IFCPROPERTYSINGLEVALUE"), (3, "IFCPROPERTYSET"), (4, "IFCRELDEFINESBYPROPERTIES")],
        "every written record is read back, and none the caller did not create: {out}"
    );

    let source = file(&[
        WALL,
        "#2=IFCPROPERTYSINGLEVALUE('P',$,IFCLABEL('v'),$);",
        "#3=IFCPROPERTYSET('2w1QZ7m8b3ExpQ1LwVfq3K',$,'S',$,(#2));",
    ]);
    let opts = StepOptions {
        copy_on_write: ["IFCLABEL('w'),$);\n#99=IFCWALL(", "IFCLABEL('w') /*"]
            .into_iter()
            .map(|value| CopyOnWriteMutation {
                express_id: 2,
                index: 2,
                value: value.into(),
                referrer_id: 3,
                referrer_index: 4,
            })
            .collect(),
        ..StepOptions::default()
    };
    let (out, stats) = export_step_with_stats(source.as_bytes(), &opts).unwrap();
    assert_eq!(stats.copies_refused, 2);
    assert_eq!(ids(&out), vec![1, 2, 3], "{out}");
    assert_eq!(scanned(&out).len(), 3, "{out}");
}

/// EXPORT-STEP-11: a repeated express id keeps the record core resolves it
/// to, the LAST one, and every earlier one is counted, in both writers. An
/// edit by id lands on that same record: the one `EntityDecoder` reads.
#[test]
fn a_repeated_express_id_keeps_the_record_core_reads_and_is_reported_7682() {
    let first = "#1=IFCWALL('3nZ2y9nY9FExK3Wg9nLvXz',$,'First',$,$,$,$,$,$);";
    let second = "#1=IFCWALL('0uK8j9R5T5E8Gf7Ybq5ZpA',$,'Second',$,$,$,$,$,$);";
    let source = file(&[first, "#2=IFCSLAB($,$,'Slab',$,$,$,$,$,$);", second]);

    let mut decoder = EntityDecoder::new(source.as_bytes());
    let core = decoder.decode_by_id(1).expect("core reads #1");
    assert_eq!(core.get_string(2), Some("Second"), "core resolves a repeated id to its last record");

    let opts = StepOptions {
        attribute_mutations: vec![AttrMutation { express_id: 1, index: 3, value: "'edited'".into() }],
        ..StepOptions::default()
    };
    let (out, stats) = export_step_with_stats(source.as_bytes(), &opts).unwrap();
    assert_eq!(stats.duplicate_records_dropped, 1);
    assert_eq!(ids(&out), vec![2, 1]);
    assert!(out.contains("#1=IFCWALL('0uK8j9R5T5E8Gf7Ybq5ZpA',$,'Second','edited',$,$,$,$,$);"), "{out}");
    assert!(!out.contains("'First'"), "{out}");

    let log = MutationLog::from_json(r#"{"mutations":[{"type":"UPDATE_ATTRIBUTE","entityId":1,"attributeName":"Description","newValue":"edited"}]}"#).unwrap();
    let (out, stats) = export_step_with_log(source.as_bytes(), &StepOptions::default(), &log).unwrap();
    assert_eq!(ids(&out), vec![1, 2]);
    assert!(out.contains("#1=IFCWALL('0uK8j9R5T5E8Gf7Ybq5ZpA',$,'Second','edited',$,$,$,$,$);"), "{out}");
    assert!(!out.contains("'First'"), "{out}");
    assert_eq!(stats.step.duplicate_records_dropped, 1);
    assert!(stats.warnings.iter().any(|w| w.starts_with("Entity #1 appears more than once")), "{:?}", stats.warnings);
}

/// EXPORT-STEP-9: the log writer refuses an export that needs an id the file
/// does not have left, instead of handing out `u32::MAX` again for every
/// generated record.
#[test]
fn the_log_writer_refuses_rather_than_reuse_the_last_id_7682() {
    let source = file(&[WALL, TOP_WALL]);
    let log = MutationLog::from_json(
        r#"{"mutations":[{"type":"CREATE_PROPERTY","entityId":1,"psetName":"Pset_X","propName":"A","newValue":"x","valueType":0}]}"#,
    )
    .unwrap();
    let err = export_step_with_log(source.as_bytes(), &StepOptions::default(), &log).expect_err("no id is left");
    assert!(err.to_string().contains("express id space"), "{err}");
}

/// EXPORT-STEP-26: a created entity's class is its record keyword, so one
/// that is not an entity name is refused rather than written.
#[test]
fn a_created_entity_whose_class_is_not_an_entity_name_is_refused_7682() {
    let source = file(&[WALL]);
    let log = MutationLog::from_json(
        r##"{"mutations":[{"type":"CREATE_ENTITY","entityId":5,"attributeName":"IfcWall"}],
            "newEntities":[{"expressId":5,"type":"IfcWall($);\n#1=IFCFOO('x'","attributes":[]}]}"##,
    )
    .unwrap();
    let err = export_step_with_log(source.as_bytes(), &StepOptions::default(), &log).expect_err("refused");
    assert!(err.to_string().contains("not a recognizable IFC entity name"), "{err}");
}

/// EXPORT-STEP-26 (#7715 review): a created entity never reuses a source id,
/// so a log that creates one under a source id was written against another
/// file. Writing either record would drop the other silently; the export is
/// refused, with the message the TypeScript writer throws.
#[test]
fn a_created_entity_reusing_a_source_id_is_refused_7682() {
    let source = file(&[WALL]);
    let log = MutationLog::from_json(
        r#"{"mutations":[{"type":"CREATE_ENTITY","entityId":1,"attributeName":"IfcWall"}],
            "newEntities":[{"expressId":1,"type":"IfcWall","attributes":["0uK8j9R5T5E8Gf7Ybq5ZpA"]}]}"#,
    )
    .unwrap();
    let err = export_step_with_log(source.as_bytes(), &StepOptions::default(), &log).expect_err("refused");
    assert!(err.to_string().contains("created entity #1 reuses source id #1"), "{err}");
}

/// #7715 review, round 2: a log that creates an entity under a source id and
/// then deletes it is refused too; replaying it would tombstone the source
/// record silently.
#[test]
fn a_created_then_deleted_entity_reusing_a_source_id_is_refused_7682() {
    let source = file(&[WALL]);
    let log = MutationLog::from_json(
        r#"{"mutations":[{"type":"CREATE_ENTITY","entityId":1,"attributeName":"IfcWall"},{"type":"DELETE_ENTITY","entityId":1}],
            "newEntities":[{"expressId":1,"type":"IfcWall","attributes":["0uK8j9R5T5E8Gf7Ybq5ZpA"]}]}"#,
    )
    .unwrap();
    let err = export_step_with_log(source.as_bytes(), &StepOptions::default(), &log).expect_err("refused");
    assert!(err.to_string().contains("created entity #1 reuses source id #1"), "{err}");
}
