// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7682: what the STEP writers refuse rather than write wrong, and count so a
//! caller learns an edit is missing (EXPORT-STEP-9/10/11/26). The plain writer
//! (`export_step_with_stats`) reports through `StepStats`; the mutation-log
//! writer (`export_step_with_log`) through its warnings, its counters, or a
//! refusal of the whole export.

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

    let source = file(&[
        WALL,
        "#2=IFCPROPERTYSINGLEVALUE('P',$,IFCLABEL('v'),$);",
        "#3=IFCPROPERTYSET('2w1QZ7m8b3ExpQ1LwVfq3K',$,'S',$,(#2));",
    ]);
    let opts = StepOptions {
        copy_on_write: vec![CopyOnWriteMutation {
            express_id: 2,
            index: 2,
            value: "IFCLABEL('w'),$);\n#99=IFCWALL(".into(),
            referrer_id: 3,
            referrer_index: 4,
        }],
        ..StepOptions::default()
    };
    let (out, stats) = export_step_with_stats(source.as_bytes(), &opts).unwrap();
    assert_eq!(stats.copies_refused, 1);
    assert_eq!(ids(&out), vec![1, 2, 3], "{out}");
}

/// EXPORT-STEP-11: a repeated express id keeps its FIRST record, and the
/// repeat is counted, in both writers.
#[test]
fn a_repeated_express_id_keeps_the_first_record_and_is_reported_7682() {
    let source = file(&[WALL, "#2=IFCSLAB($,$,'Slab',$,$,$,$,$,$);", "#1=IFCWALL('second',$,'Second',$,$,$,$,$,$);"]);
    let (out, stats) = export_step_with_stats(source.as_bytes(), &StepOptions::default()).unwrap();
    assert_eq!(stats.duplicate_records_dropped, 1);
    assert_eq!(ids(&out), vec![1, 2]);
    assert!(out.contains(WALL) && !out.contains("'Second'"), "{out}");

    let log = MutationLog::from_json(r#"{"mutations":[]}"#).unwrap();
    let (out, stats) = export_step_with_log(source.as_bytes(), &StepOptions::default(), &log).unwrap();
    assert_eq!(ids(&out), vec![1, 2]);
    assert!(out.contains(WALL) && !out.contains("'Second'"), "{out}");
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
