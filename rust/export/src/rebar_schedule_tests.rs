use super::*;

const REBAR: &str = include_str!("../../geometry/tests/fixtures/swept_disk_composite_arc_ubar.ifc");
const MAPPED: &str = include_str!("../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc");

#[test]
fn issue_5759_revit_snowdon_schedule_preserves_authored_and_measured_lengths() {
    // Revit 24.2.0.63 / IFC 24.2.0.63, from the catalogued structural model.
    let Some(content) = crate::test_support::fixture_opt(
        "various/01_Snowdon_Towers_Sample_Structural(1).ifc",
    ) else {
        return; // fixture_opt reports the `pnpm fixtures` command.
    };
    let ids = HashSet::from([132347, 132418, 132562]);
    let schedule = build_rebar_schedule(&content, Some(&ids), &SweptDiskCheckOptions::default())
        .unwrap();
    assert_eq!(schedule.rows.keys().copied().collect::<Vec<_>>(),
        vec![132347, 132418, 132562]);
    assert_eq!(schedule.bar_entity_count, 3);
    assert_eq!(schedule.represented_sweep_count, 3);

    let bar = &schedule.rows[&132347];
    let AuthoredRebarValue::Measure { value_si: authored_m, .. } =
        &bar.authored["BarLength"].value else {
        panic!("Revit BarLength must remain an authored measure");
    };
    let metrics = bar.sweeps[0].directrix_metrics.as_ref().unwrap();
    assert!((authored_m - 3.6068).abs() < 1e-6);
    assert!((metrics.total_length - 3.61642001695).abs() < 1e-6);
    assert_eq!(metrics.segments.len(), 11);
    assert_eq!(metrics.segments.iter().filter(|part| part.bend_angle.is_some()).count(), 5);
    assert!((metrics.total_length - authored_m).abs() > 0.009);
}

#[test]
fn issue_5759_keeps_authored_and_derived_lengths_separate() {
    let authored = REBAR.replace(
        "#125=IFCREINFORCINGBAR('0Test0000000000000Ubar',$,'U-bar',$,$,#33,#124,$,$,29.,0.,$,.NOTDEFINED.,$);",
        "#125=IFCREINFORCINGBAR('0Test0000000000000Ubar',$,'U-bar',$,$,#33,#124,'T1','B500B',29.,0.00066,900.,.MAIN.,$);",
    );
    let schedule =
        build_rebar_schedule(authored.as_bytes(), None, &SweptDiskCheckOptions::default()).unwrap();
    assert_eq!(schedule.bar_entity_count, 1);
    assert_eq!(schedule.represented_sweep_count, 1);
    assert!((schedule.length_unit_scale - 0.001).abs() < 1e-12);
    let row = &schedule.rows[&125];
    assert_eq!(row.GlobalId.as_deref(), Some("0Test0000000000000Ubar"));
    assert_eq!(row.Name.as_deref(), Some("U-bar"));
    let serialized = serde_json::to_value(row).unwrap();
    assert_eq!(serialized["GlobalId"], "0Test0000000000000Ubar");
    assert_eq!(serialized["Name"], "U-bar");
    assert!(serialized.get("global_id").is_none());
    assert!(serialized.get("name").is_none());
    assert_eq!(row.authored["Tag"].source, RebarSource::Occurrence);
    assert_eq!(
        row.authored["BarLength"].value,
        AuthoredRebarValue::Measure {
            value_file_units: 900.0,
            value_si: 0.9,
            si_unit: "m",
        }
    );
    // This IFC declares millimetres for LENGTHUNIT but square metres for
    // AREAUNIT. The latter must not be multiplied by the length scale twice.
    assert_eq!(
        row.authored["CrossSectionArea"].value,
        AuthoredRebarValue::Measure {
            value_file_units: 0.00066,
            value_si: 0.00066,
            si_unit: "m2",
        }
    );
    assert!((row.sweeps[0].radius_m - 0.0145).abs() < 1e-12);
    assert!(
        (row.sweeps[0]
            .directrix_metrics
            .as_ref()
            .unwrap()
            .total_length
            - 0.9)
            .abs()
            > 1e-3
    );
    assert!(row.sweeps[0].checks.findings.is_empty());
}

#[test]
fn issue_5759_unresolved_declared_area_unit_does_not_invent_si_area() {
    let source = REBAR
        .replace(
            "#7=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);",
            "#7=IFCCONVERSIONBASEDUNIT($,.AREAUNIT.,'UNKNOWN_AREA',$);",
        )
        .replace("29.,0.,$,.NOTDEFINED.", "29.,0.00066,$,.NOTDEFINED.");
    let schedule =
        build_rebar_schedule(source.as_bytes(), None, &SweptDiskCheckOptions::default()).unwrap();
    let row = &schedule.rows[&125];
    assert!(!row.authored.contains_key("CrossSectionArea"));
    assert!(row
        .diagnostics
        .iter()
        .any(|message| message == "CrossSectionArea on occurrence: unresolved project area unit"));
    assert_eq!(row.sweeps.len(), 1);
}

#[test]
fn issue_5759_type_fallback_conflict_and_missing_geometry() {
    let source = REBAR.replace("FILE_SCHEMA(('IFC2X3'))", "FILE_SCHEMA(('IFC4'))").replace(
        "ENDSEC;\nEND-ISO-10303-21;",
        "#9000=IFCREINFORCINGBARTYPE('type',$,'Type',$,$,$,$,$,$,.SHEAR.,32.,$,800.,$,'S1',$);\n\
         #9001=IFCRELDEFINESBYTYPE('rel',$,$,$,(#125),#9000);\n\
         ENDSEC;\nEND-ISO-10303-21;",
    );
    let schedule =
        build_rebar_schedule(source.as_bytes(), None, &SweptDiskCheckOptions::default()).unwrap();
    let row = &schedule.rows[&125];
    assert_eq!(row.type_id, Some(9000));
    assert_eq!(
        row.authored["NominalDiameter"].source,
        RebarSource::Occurrence
    );
    assert_eq!(row.authored["BarLength"].source, RebarSource::Type);
    assert!(row
        .diagnostics
        .iter()
        .any(|message| message.starts_with("NominalDiameter differs")));

    let absent = source.replace("#33,#124,$,$,29.", "#33,$,$,$,29.");
    let schedule =
        build_rebar_schedule(absent.as_bytes(), None, &SweptDiskCheckOptions::default()).unwrap();
    assert!(schedule.rows[&125].sweeps.is_empty());
    assert!(schedule.rows[&125].geometry_unavailable_reason.is_some());
}

#[test]
fn issue_5759_invalid_first_type_assignment_does_not_hide_valid_type_metadata() {
    let file = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
        #1=IFCREINFORCINGBAR('bar',$,'Bar',$,$,$,$,$,$,$,$,$,$,$);\n\
        #2=IFCREINFORCINGBARTYPE('type',$,'Type',$,$,$,$,$,$,.MAIN.,12.,$,900.,$,$,$);\n\
        #3=IFCREINFORCINGBARTYPE('other',$,'Other',$,$,$,$,$,$,.SHEAR.,16.,$,800.,$,$,$);\n\
        #4=IFCRELDEFINESBYTYPE('invalid',$,$,$,(#1),#99);\n\
        #5=IFCRELDEFINESBYTYPE('valid',$,$,$,(#1),#2);\n\
        #6=IFCRELDEFINESBYTYPE('conflict',$,$,$,(#1),#3);\n\
        ENDSEC;\nEND-ISO-10303-21;\n";
    let schedule = build_rebar_schedule(file, None, &SweptDiskCheckOptions::default()).unwrap();
    let row = &schedule.rows[&1];
    assert_eq!(row.type_id, Some(2));
    assert_eq!(row.authored["BarLength"].source_id, 2);
    assert_eq!(row.authored["BarLength"].value,
        AuthoredRebarValue::Measure { value_file_units: 900.0, value_si: 900.0, si_unit: "m" });
    assert!(row.diagnostics.iter().any(|message| message.contains("assigned type #99")));
    assert!(row.diagnostics.iter().any(|message| message.contains("#2 and #3")));
}

#[test]
fn issue_5759_malformed_type_links_report_lost_authored_bar_length_with_bounded_diagnostics() {
    let prefix = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
        #1=IFCREINFORCINGBAR('bar',$,'Bar',$,$,$,$,$,$,$,$,$,$,$);\n\
        #2=IFCREINFORCINGBARTYPE('type',$,'Type',$,$,$,$,$,$,.MAIN.,12.,$,900.,$,$,$);\n";
    let suffix = "ENDSEC;\nEND-ISO-10303-21;\n";
    let valid = format!("{prefix}#3=IFCRELDEFINESBYTYPE('rel',$,$,$,(#1),#2);\n{suffix}");
    let schedule = build_rebar_schedule(valid.as_bytes(), None, &SweptDiskCheckOptions::default()).unwrap();
    assert_eq!(schedule.rows[&1].authored["BarLength"].source, RebarSource::Type);
    let unreadable_type = valid.replace("900.", "?");
    let schedule = build_rebar_schedule(unreadable_type.as_bytes(), None, &SweptDiskCheckOptions::default()).unwrap();
    assert!(!schedule.rows[&1].authored.contains_key("BarLength"));
    assert!(schedule.diagnostics.iter().any(|message| message == "type #2: cannot decode"));
    assert!(schedule.rows[&1].diagnostics.iter().any(|message| message == "assigned type #2 could not decode"));
    for (related, relating, expected) in [
        ("$", "#2", "RelatedObjects is not a reference list"),
        ("(#1)", "$", "RelatingType is not a reference"),
        ("()", "#2", "RelatedObjects is empty"),
    ] {
        let file = format!(
            "{prefix}#3=IFCRELDEFINESBYTYPE('rel',$,$,$,{related},{relating});\n{suffix}"
        );
        let schedule = build_rebar_schedule(file.as_bytes(), None, &SweptDiskCheckOptions::default()).unwrap();
        assert!(!schedule.rows[&1].authored.contains_key("BarLength"));
        assert!(schedule.diagnostics.iter().any(|message| message.contains(expected)));
    }
    let undecodable = format!("{prefix}#3=IFCRELDEFINESBYTYPE('rel',$,$,$,(#1),?);\n{suffix}");
    let schedule = build_rebar_schedule(undecodable.as_bytes(), None, &SweptDiskCheckOptions::default()).unwrap();
    assert!(!schedule.rows[&1].authored.contains_key("BarLength"));
    assert!(schedule.diagnostics.iter().any(|message| message == "type relationship #3: cannot decode"));
    let mut file = prefix.to_string();
    for id in 3..133 {
        file.push_str(&format!("#{id}=IFCRELDEFINESBYTYPE('rel',$,$,$,$,#2);\n"));
    }
    file.push_str(suffix);
    let schedule = build_rebar_schedule(file.as_bytes(), None, &SweptDiskCheckOptions::default()).unwrap();
    assert_eq!(schedule.diagnostics.iter().filter(|message| message.starts_with("type relationship #")).count(), 128);
    assert!(schedule.diagnostics.iter().any(|message| message == "further type-link diagnostics omitted"));
}

#[test]
fn issue_5759_ifc2x3_uses_barrole_not_predefinedtype() {
    let file = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n\
        #1=IFCREINFORCINGBAR('bar',$,'Bar',$,$,$,$,'T1','B500B',12.,113.,1500.,.MAIN.,.PLAIN.);\n\
        ENDSEC;\nEND-ISO-10303-21;\n";
    let schedule = build_rebar_schedule(file, None, &SweptDiskCheckOptions::default()).unwrap();
    let row = &schedule.rows[&1];
    assert_eq!(
        row.authored["BarRole"].value,
        AuthoredRebarValue::Text {
            value: "MAIN".into()
        }
    );
    assert!(!row.authored.contains_key("PredefinedType"));
    assert!(row.sweeps.is_empty());
}

#[test]
fn issue_5759_reused_mapping_and_csg_operands_remain_occurrence_distinct() {
    let source = MAPPED.replace(
        "ENDSEC;\nEND-ISO-10303-21;",
        "#51=IFCREINFORCINGBAR('0000000000000000000003',$,'Bar 2',$,$,#30,#49,'BAR-2',$,29.,0.,$,.NOTDEFINED.,$);\n\
         ENDSEC;\nEND-ISO-10303-21;",
    );
    let schedule =
        build_rebar_schedule(source.as_bytes(), None, &SweptDiskCheckOptions::default()).unwrap();
    assert_eq!(schedule.bar_entity_count, 2);
    assert_eq!(schedule.represented_sweep_count, 2);
    for id in [50, 51] {
        assert_eq!(schedule.rows[&id].sweeps[0].mapping_path, vec![47]);
        assert_eq!(schedule.rows[&id].sweeps[0].solid_id, 43);
        assert!(schedule.rows[&id].sweeps[0].source.is_some());
    }
    assert_eq!(schedule.rows[&50].sweeps[0].source,
        schedule.rows[&51].sweeps[0].source);

    let modified = MAPPED.replace(
        "#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#43));",
        "#1001=IFCBOOLEANRESULT(.UNION.,#43,#43);\n\
         #44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#1001));",
    );
    let schedule =
        build_rebar_schedule(modified.as_bytes(), None, &SweptDiskCheckOptions::default()).unwrap();
    let sweeps = &schedule.rows[&50].sweeps;
    assert_eq!(sweeps.len(), 2);
    assert_eq!(
        [sweeps[0].occurrence_index, sweeps[1].occurrence_index],
        [0, 1]
    );
    assert!(sweeps
        .iter()
        .all(|sweep| sweep.source_modified && sweep.checks.source_modified));
    assert_eq!(sweeps[0].source, sweeps[1].source);
}

#[test]
fn issue_5759_invalid_authored_measures_are_reported_and_omitted() {
    let source = REBAR.replace("29.,0.,$,.NOTDEFINED.", "0.,-1.,0.,.NOTDEFINED.");
    let schedule =
        build_rebar_schedule(source.as_bytes(), None, &SweptDiskCheckOptions::default()).unwrap();
    let row = &schedule.rows[&125];
    for name in ["NominalDiameter", "CrossSectionArea", "BarLength"] {
        assert!(!row.authored.contains_key(name));
        assert!(row
            .diagnostics
            .iter()
            .any(|message| message.starts_with(name)));
    }
    assert_eq!(row.sweeps.len(), 1);
}

#[test]
fn issue_5759_type_relation_work_budget_acts_and_reports() {
    let refs = vec!["#999"; MAX_TYPE_RELATION_REFERENCES].join(",");
    let source = format!(
        "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
         #1=IFCREINFORCINGBAR('bar',$,'Bar',$,$,$,$,$,$,12.,$,$,.MAIN.,$);\n\
         #2=IFCREINFORCINGBARTYPE('type',$,'Type',$,$,$,$,$,$,.MAIN.,12.,$,900.,$,$,$);\n\
         #3=IFCRELDEFINESBYTYPE('rel',$,$,$,({refs},#1),#2);\n\
         ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let schedule =
        build_rebar_schedule(source.as_bytes(), None, &SweptDiskCheckOptions::default()).unwrap();
    assert_eq!(schedule.rows[&1].type_id, None);
    assert!(schedule
        .diagnostics
        .iter()
        .any(|message| message.contains("work budget")));
}
