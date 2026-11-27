// SPDX-License-Identifier: MPL-2.0
use ifc_lite_export::{
    export_merged_models, export_step, export_step_with_diagnostics, export_step_with_log,
    AttrMutation, MergedModel, MergedOptions, StepOptions,
};

const LEGACY: &str = include_str!("fixtures/schema_duration_timeunit.ifc");

fn options(schema: &str) -> StepOptions {
    StepOptions {
        schema: Some(schema.into()),
        ..Default::default()
    }
}

#[test]
fn edited_second_becomes_millisecond_for_both_downgrade_writers_11192() {
    let seconds = LEGACY
        .replace("((#6))", "((#3))")
        .replace("10.,$,$,$,.ACTUAL.", "10.,-2.,$,$,.ACTUAL.");
    for modern in ["IFC4", "IFC4X3"] {
        let input = export_step(seconds.as_bytes(), &options(modern)).unwrap();
        assert!(input.contains("'PT10S','-PT2S'"), "{input}");
        let edited = StepOptions {
            attribute_mutations: vec![AttrMutation {
                express_id: 3,
                index: 2,
                value: ".MILLI.".into(),
            }],
            ..options("IFC2X3")
        };
        let (direct, _, warnings) =
            export_step_with_diagnostics(input.as_bytes(), &edited).unwrap();
        let log = serde_json::from_value(serde_json::json!({"mutations":[
            {"type":"UPDATE_POSITIONAL_ATTRIBUTE","entityId":3,"attributeName":"@2","newValue":".MILLI."}
        ]})).unwrap();
        let (logged, stats) =
            export_step_with_log(input.as_bytes(), &options("IFC2X3"), &log).unwrap();
        for (out, warnings) in [(direct, warnings), (logged, stats.warnings)] {
            assert!(
                out.contains("IFCSIUNIT(*,.TIMEUNIT.,.MILLI.,.SECOND.)"),
                "{out}"
            );
            assert!(out.contains("10000.,-2000."), "{out}");
            assert!(
                !warnings.iter().any(|w| w.contains("assumed seconds")),
                "{warnings:?}"
            );
        }
    }
}

#[test]
fn upgrade_uses_each_source_unit_in_a_merge_and_the_source_unit_in_a_subset_11192() {
    let seconds = LEGACY
        .replace("((#6))", "((#3))")
        .replace("1Yvct", "2Yvct")
        .replace("IFCWORKPLAN(", "IFCWORKSCHEDULE(");
    for schema in ["IFC4", "IFC4X3"] {
        let (direct, _, warnings) = export_step_with_diagnostics(LEGACY.as_bytes(), &options(schema)).unwrap();
        assert!(direct.contains("'PT600S'"), "{direct}");
        assert!(!warnings.iter().any(|w| w.contains("assumed seconds")), "{warnings:?}");
        let (merged, _) = export_merged_models(
            &[
                MergedModel::new(LEGACY.as_bytes()),
                MergedModel::new(seconds.as_bytes()),
            ],
            &MergedOptions {
                schema: Some(schema.into()),
                ..Default::default()
            },
        );
        assert!(
            merged
                .lines()
                .any(|l| l.contains("IFCWORKPLAN(") && l.contains("'PT600S'")),
            "{merged}"
        );
        assert!(
            merged
                .lines()
                .any(|l| l.contains("IFCWORKSCHEDULE(") && l.contains("'PT10S'")),
            "{merged}"
        );
        let subset = StepOptions {
            included: Some(vec![7]),
            ..options(schema)
        };
        let (out, _, warnings) = export_step_with_diagnostics(LEGACY.as_bytes(), &subset).unwrap();
        assert!(out.contains("'PT600S'"), "{out}");
        assert!(
            !warnings.iter().any(|w| w.contains("assumed seconds")),
            "{warnings:?}"
        );
    }
}

#[test]
fn merged_downgrade_uses_the_retained_project_and_reports_unresolved_units_11192() {
    let seconds = LEGACY
        .replace("((#6))", "((#3))")
        .replace("1Yvct", "2Yvct")
        .replace("IFCWORKPLAN(", "IFCWORKSCHEDULE(");
    for schema in ["IFC4", "IFC4X3"] {
        let minutes = export_step(LEGACY.as_bytes(), &options(schema)).unwrap();
        let seconds = export_step(seconds.as_bytes(), &options(schema)).unwrap();
        let (merged, stats) = export_merged_models(
            &[
                MergedModel::new(minutes.as_bytes()),
                MergedModel::new(seconds.as_bytes()),
            ],
            &MergedOptions {
                schema: Some("IFC2X3".into()),
                ..Default::default()
            },
        );
        assert!(
            merged
                .lines()
                .any(|l| l.contains("IFCWORKPLAN(") && l.contains(",10.,")),
            "{merged}"
        );
        assert!(
            merged
                .lines()
                .any(|l| l.contains("IFCWORKSCHEDULE(") && l.contains(",0.16666666666666666,")),
            "{merged}"
        );
        assert!(
            !stats.warnings.iter().any(|w| w.contains("assumed seconds")),
            "{:?}",
            stats.warnings
        );
    }
    for bad in [
        LEGACY.replace("((#6))", "((#6,#3))"),
        LEGACY.replace("IFCRATIOMEASURE(60.)", "IFCLABEL(60.)"),
        LEGACY.replace("IFCRATIOMEASURE(60.)", "IFCINTEGER(60.5)"),
        LEGACY.replace("IFCRATIOMEASURE(60.)", "IFCNORMALISEDRATIOMEASURE(60.)"),
        LEGACY.replace("IFCRATIOMEASURE(60.)", "IFCRATIOMEASURE(0.)"),
        LEGACY.replace("IFCRATIOMEASURE(60.),#3", "IFCRATIOMEASURE(60.),#6"),
    ] {
        let (out, _, warnings) =
            export_step_with_diagnostics(bad.as_bytes(), &options("IFC4")).unwrap();
        assert!(out.contains("'PT10S'"), "{out}");
        assert_eq!(
            warnings
                .iter()
                .filter(|w| w.contains("assumed seconds"))
                .count(),
            1
        );
    }
}
