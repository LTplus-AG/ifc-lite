// SPDX-License-Identifier: MPL-2.0
use ifc_lite_export::{
    export_merged_models, export_merged_models_with_logs, export_step, export_step_with_diagnostics, export_step_with_log,
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

#[test]
fn subset_upgrade_reads_edits_to_units_outside_the_subset_11192() {
    for schema in ["IFC4", "IFC4X3"] {
        let subset = StepOptions { included: Some(vec![7]), ..options(schema) };
        let error = export_step_with_log(LEGACY.as_bytes(), &subset, &Default::default()).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("`included` is not supported with a mutation log"));

        let edited = StepOptions {
            attribute_mutations: vec![AttrMutation {
                express_id: 4, index: 0, value: "IFCRATIOMEASURE(120.)".into(),
            }],
            ..subset
        };
        let (out, _, warnings) = export_step_with_diagnostics(LEGACY.as_bytes(), &edited).unwrap();
        assert!(!out.contains("=IFCPROJECT("), "{out}");
        assert!(out.contains("'PT1200S'"), "{out}");
        assert!(!warnings.iter().any(|w| w.contains("assumed seconds")), "{warnings:?}");

        let log = serde_json::from_value(serde_json::json!({"mutations":[
            {"type":"UPDATE_POSITIONAL_ATTRIBUTE","entityId":3,"attributeName":"@2","newValue":".MILLI."}
        ]})).unwrap();
        let mut model = MergedModel::new(LEGACY.as_bytes());
        model.included = Some(vec![7]);
        for (edits, expected) in [(None, "'PT600S'"), (Some(&log), "'PT0.6S'")] {
            let (out, stats) = export_merged_models_with_logs(
                std::slice::from_ref(&model), &[edits],
                &MergedOptions { schema: Some(schema.into()), ..Default::default() },
            ).unwrap();
            assert!(!out.contains("=IFCPROJECT("), "{out}");
            assert!(out.contains(expected), "{out}");
            assert!(!stats.warnings.iter().any(|w| w.contains("assumed seconds")), "{:?}", stats.warnings);
        }
    }
}

#[test]
fn federated_downgrade_uses_each_retained_project_time_unit_11192() {
    let minutes = LEGACY.replace("((#6))", "((#6,#8))")
        .replace("#7=", "#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n#7=")
        .replace("10.,$,$,$,.ACTUAL.", "10.,-2.,$,$,.ACTUAL.");
    let seconds = minutes.replace("#6,#8", "#3,#8").replace("LENGTHUNIT.,$", "LENGTHUNIT.,.MILLI.")
        .replace("1Yvct", "2Yvct").replace("IFCWORKPLAN(", "IFCWORKSCHEDULE(");
    for schema in ["IFC4", "IFC4X3"] {
        let a = export_step(minutes.as_bytes(), &options(schema)).unwrap();
        let b = export_step(seconds.as_bytes(), &options(schema)).unwrap();
        let (out, stats) = export_merged_models(
            &[MergedModel::new(a.as_bytes()), MergedModel::new(b.as_bytes())],
            &MergedOptions { schema: Some("IFC2X3".into()), ..Default::default() },
        );
        assert_eq!(stats.federated_model_count, 1);
        assert_eq!(out.matches("=IFCPROJECT(").count(), 2);
        for ty in ["IFCWORKPLAN(", "IFCWORKSCHEDULE("] {
            assert!(out.lines().any(|line| line.contains(ty) && line.contains(",10.,-2.,")), "{out}");
        }
        assert!(!stats.warnings.iter().any(|w| w.contains("assumed seconds")), "{:?}", stats.warnings);
        let conflict = b.replace("((#3,#8))", "((#3,#6,#8))");
        let (out, stats) = export_merged_models(
            &[MergedModel::new(a.as_bytes()), MergedModel::new(conflict.as_bytes())],
            &MergedOptions { schema: Some("IFC2X3".into()), ..Default::default() },
        );
        assert!(out.lines().any(|line| line.contains("IFCWORKPLAN(") && line.contains(",10.,-2.,")), "{out}");
        assert!(out.lines().any(|line| line.contains("IFCWORKSCHEDULE(") && line.contains(",10.,-2.,")), "{out}");
        assert_eq!(stats.warnings.iter().filter(|w| w.contains("assumed seconds")).count(), 1);
    }
}
