// SPDX-License-Identifier: MPL-2.0
use crate::schema_convert::convert_step_line;
use crate::schema_enum::ConversionChecks;
use crate::schema_ifc2x3_slots::Ifc2x3SlotFill;

/// The output, the values counted dropped, and the warnings.
fn convert(line: &str, from: &str, to: &str) -> (String, usize, Vec<String>) {
    let mut checks = ConversionChecks::default();
    let out = convert_step_line(line, from, to, 5, &mut Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
    (out, checks.attribute_values_dropped, checks.forms.warnings())
}

/// The issue's examples: a date reference in an IFC4 date string slot, a time
/// measure in a duration string slot, a real in an IfcLagTime reference slot,
/// and a date string in an IFC2X3 date reference slot.
#[test]
fn a_value_the_target_slot_cannot_hold_is_dropped_and_named_10847() {
    let (out, dropped, warnings) = convert("#5=IFCCLASSIFICATION('src','1',#9,'name');", "IFC2X3", "IFC4");
    assert_eq!((out.as_str(), dropped), ("#5=IFCCLASSIFICATION('src','1',$,'name',$,$,$);", 1));
    assert_eq!(warnings, ["1 value(s) of a type the target slot does not accept were dropped: IFCCLASSIFICATION.EditionDate (#10847)."]);
    let (out, dropped, _) = convert("#5=IFCWORKPLAN('g',$,'n',$,$,'id',#9,$,$,10.,2.,#10,$,.ACTUAL.,$);", "IFC2X3", "IFC4");
    assert_eq!((out.as_str(), dropped), ("#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,'PT10S','PT2S',$,$,.ACTUAL.);", 2));
    let (out, _, _) = convert("#5=IFCRELSEQUENCE('g',$,$,$,#6,#7,2.,.START_START.);", "IFC2X3", "IFC4");
    assert_eq!(out, "#5=IFCRELSEQUENCE('g',$,$,$,#6,#7,$,.START_START.,$);");
    let (out, _, _) = convert("#5=IFCCLASSIFICATION('src','1','2020-01-01','name',$,$,$);", "IFC4", "IFC2X3");
    assert_eq!(out, "#5=IFCCLASSIFICATION('src','1',$,'name');");
}

/// A typed value IFC2X3 has no type for is dropped, and only that member of a list.
#[test]
fn a_typed_value_the_target_lacks_is_dropped_member_by_member_10847() {
    let (out, dropped, _) = convert("#5=IFCPROPERTYSINGLEVALUE('n',$,IFCBINARY(\"0A\"),$);", "IFC4X3", "IFC2X3");
    assert_eq!((out.as_str(), dropped), ("#5=IFCPROPERTYSINGLEVALUE('n',$,$,$);", 1));
    let (out, dropped, _) = convert("#5=IFCPROPERTYLISTVALUE('n',$,(IFCLABEL('a'),IFCBINARY(\"0A\")),$);", "IFC4X3", "IFC2X3");
    assert_eq!((out.as_str(), dropped), ("#5=IFCPROPERTYLISTVALUE('n',$,(IFCLABEL('a')),$);", 1));
    // A value the target accepts is left as written, comments and all.
    let kept = "#5=IFCPROPERTYSINGLEVALUE('n',$,IFCLABEL('a') /* c */,$);";
    assert_eq!(convert(kept, "IFC4X3", "IFC2X3").0, kept);
}

/// What converts without loss is converted: a parameter wrapped for IFC4X3's
/// select and unwrapped back, an integral count written as an integer.
#[test]
fn a_value_that_converts_without_loss_is_converted_10847() {
    let (out, dropped, _) = convert("#5=IFCFIXEDREFERENCESWEPTAREASOLID(#1,#2,#3,0.,1.,#6);", "IFC4", "IFC4X3");
    assert_eq!((out.as_str(), dropped), ("#5=IFCFIXEDREFERENCESWEPTAREASOLID(#1,#2,#3,IFCPARAMETERVALUE(0.),IFCPARAMETERVALUE(1.),#6);", 0));
    let (out, dropped, _) = convert("#5=IFCFIXEDREFERENCESWEPTAREASOLID(#1,#2,#3,IFCPARAMETERVALUE(0.),IFCLENGTHMEASURE(1.),#6);", "IFC4X3", "IFC4");
    assert_eq!((out.as_str(), dropped), ("#5=IFCFIXEDREFERENCESWEPTAREASOLID(#1,#2,#3,0.,$,#6);", 1));
    assert_eq!(convert("#5=IFCQUANTITYCOUNT('n',$,$,3.,$);", "IFC4", "IFC4X3").0, "#5=IFCQUANTITYCOUNT('n',$,$,3,$);");
    let (out, dropped, _) = convert("#5=IFCQUANTITYCOUNT('n',$,$,2.5,$);", "IFC4", "IFC4X3");
    assert_eq!((out.as_str(), dropped), ("#5=IFCQUANTITYCOUNT('n',$,$,$,$);", 1));
}

/// Without the export's checks, nothing is reconciled, as for enum members.
#[test]
fn convert_step_line_without_checks_is_unchanged_10847() {
    let out = convert_step_line("#5=IFCCLASSIFICATION('src','1',#9,'name');", "IFC2X3", "IFC4", 5, &mut Ifc2x3SlotFill::new(None), None).unwrap();
    assert_eq!(out, "#5=IFCCLASSIFICATION('src','1',#9,'name',$,$,$);");
}

/// The lookup binary-searches the generated table, so it must be sorted by
/// the tuple, each type once (the generator once sorted by a joined string).
#[test]
fn the_table_is_sorted_for_the_lookup_10847() {
    let keys: Vec<_> = crate::generated::value_forms::VALUE_FORM_SLOTS.iter().map(|(f, t, ty, _)| (*f, *t, *ty)).collect();
    assert!(keys.len() > 50, "anti-vacuity: {}", keys.len());
    assert!(keys.windows(2).all(|w| w[0] < w[1]), "not strictly sorted");
}

/// From review: a trailing comment does not change a value's form, an
/// aggregate whose members are all rejected counts each member once, and a
/// drop that empties a required slot says the file is now invalid.
#[test]
fn comments_counts_and_required_slots_10847() {
    assert_eq!(convert("#5=IFCQUANTITYCOUNT('n',$,$,3. /* c */,$);", "IFC4", "IFC4X3").0, "#5=IFCQUANTITYCOUNT('n',$,$,3,$);");
    assert_eq!(convert("#5=IFCQUANTITYCOUNT('n',$,$,3 /* see */,$);", "IFC4", "IFC4X3").0, "#5=IFCQUANTITYCOUNT('n',$,$,3 /* see */,$);");
    let (out, dropped, _) = convert("#5=IFCFILLAREASTYLETILES(#1,(#2,#3),1.);", "IFC2X3", "IFC4");
    assert_eq!((out.as_str(), dropped), ("#5=IFCFILLAREASTYLETILES($,$,1.);", 3));
    let (_, _, warnings) = convert("#5=IFCQUANTITYCOUNT('n',$,$,2.5,$);", "IFC4", "IFC4X3");
    assert_eq!(warnings, ["1 value(s) of a type the target slot does not accept left a slot the target requires as $, so the file is not valid against its header: IFCQUANTITYCOUNT.CountValue (#10847)."]);
}

/// From CodeRabbit: a real is whole by its digits, not after float rounding.
#[test]
fn a_fraction_float_rounding_hides_is_still_dropped_10847() {
    let (out, dropped, _) = convert("#5=IFCQUANTITYCOUNT('n',$,$,2.0000000000000001,$);", "IFC4", "IFC4X3");
    assert_eq!((out.as_str(), dropped), ("#5=IFCQUANTITYCOUNT('n',$,$,$,$);", 1));
    assert_eq!(convert("#5=IFCQUANTITYCOUNT('n',$,$,20.E-1,$);", "IFC4", "IFC4X3").0, "#5=IFCQUANTITYCOUNT('n',$,$,2,$);");
    assert_eq!(convert("#5=IFCQUANTITYCOUNT('n',$,$,25.E-1,$);", "IFC4", "IFC4X3").0, "#5=IFCQUANTITYCOUNT('n',$,$,$,$);");
    assert_eq!(convert("#5=IFCQUANTITYCOUNT('n',$,$,3.E2,$);", "IFC4", "IFC4X3").0, "#5=IFCQUANTITYCOUNT('n',$,$,300,$);");
}

/// Positional
/// members go whole, with the slots they pair with; a non-positional list
/// still loses only the member.
#[test]
fn positional_members_are_dropped_whole_with_their_partners_10847() {
    let table = "#5=IFCPROPERTYTABLEVALUE('t',$,(IFCBINARY(\"0A\"),IFCLABEL('k')),(IFCLABEL('v1'),IFCLABEL('v2')),$,$,$,$);";
    let (out, dropped, warnings) = convert(table, "IFC4", "IFC2X3");
    assert_eq!((out.as_str(), dropped), ("#5=IFCPROPERTYTABLEVALUE('t',$,$,$,$,$,$);", 4));
    assert_eq!(warnings, ["4 value(s) of a type the target slot does not accept left a slot the target requires as $, so the file is not valid against its header: IFCPROPERTYTABLEVALUE.DefinedValues, IFCPROPERTYTABLEVALUE.DefiningValues (#10847)."]);
    let uri = "#5=IFCPROPERTYTABLEVALUE('t',$,(IFCLABEL('k1'),IFCLABEL('k2')),(IFCLABEL('v'),IFCURIREFERENCE('u')),$,$,$,$);";
    let (out, dropped, warnings) = convert(uri, "IFC4X3", "IFC4");
    assert_eq!((out.as_str(), dropped), ("#5=IFCPROPERTYTABLEVALUE('t',$,$,$,$,$,$,$);", 4));
    assert_eq!(warnings, ["4 value(s) of a type the target slot does not accept were dropped: IFCPROPERTYTABLEVALUE.DefinedValues, IFCPROPERTYTABLEVALUE.DefiningValues (#10847)."]);
    assert_eq!(convert("#5=IFCTABLEROW((IFCLABEL('a'),IFCBINARY(\"0A\")),.F.);", "IFC4", "IFC2X3").0, "#5=IFCTABLEROW($,.F.);");
    let (out, dropped, _) = convert("#5=IFCPROPERTYLISTVALUE('n',$,(IFCLABEL('a'),IFCBINARY(\"0A\")),$);", "IFC4", "IFC2X3");
    assert_eq!((out.as_str(), dropped), ("#5=IFCPROPERTYLISTVALUE('n',$,(IFCLABEL('a')),$);", 1));
}

/// A one-member IfcPropertySetDefinitionSet is its member in IFC2X3; more than one has no IFC2X3 form.
#[test]
fn a_one_member_property_set_definition_set_is_unwrapped_10847() {
    let (out, dropped, warnings) = convert("#5=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#7),IFCPROPERTYSETDEFINITIONSET((#9)));", "IFC4", "IFC2X3");
    assert_eq!((out.as_str(), dropped, warnings.len()), ("#5=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#7),#9);", 0, 0));
    // An empty set (already invalid: SET [1:?]) still names the slot it empties.
    let (out, dropped, warnings) = convert("#5=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#7),IFCPROPERTYSETDEFINITIONSET(()));", "IFC4", "IFC2X3");
    assert_eq!((out.as_str(), dropped, warnings.len()), ("#5=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#7),$);", 1, 1));
    let (out, dropped, warnings) = convert("#5=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#7),IFCPROPERTYSETDEFINITIONSET((#9,#10)));", "IFC4X3", "IFC2X3");
    // Each property set the set linked is lost.
    assert_eq!((out.as_str(), dropped), ("#5=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#7),$);", 2));
    assert_eq!(warnings, ["2 value(s) of a type the target slot does not accept left a slot the target requires as $, so the file is not valid against its header: IFCRELDEFINESBYPROPERTIES.RelatingPropertyDefinition (#10847)."]);
}

/// A required aggregate that may be empty is written `()` when it loses every member.
#[test]
fn a_required_aggregate_that_may_be_empty_is_written_empty_10847() {
    let (out, dropped, warnings) = convert("#5=IFCPRESENTATIONLAYERWITHSTYLE('L',$,(#2),$,.T.,.F.,.F.,(IFCNULLSTYLE(.NULL.)));", "IFC2X3", "IFC4");
    assert_eq!((out.as_str(), dropped), ("#5=IFCPRESENTATIONLAYERWITHSTYLE('L',$,(#2),$,.T.,.F.,.F.,());", 1));
    assert_eq!(warnings, ["1 value(s) of a type the target slot does not accept were dropped: IFCPRESENTATIONLAYERWITHSTYLE.LayerStyles (#10847)."]);
}

/// Local CodeRabbit on #10878, the twin of the TypeScript case: IFC4X3 made
/// IfcCountMeasure an INTEGER, so a typed count's payload converts too.
#[test]
fn a_typed_count_payload_becomes_an_ifc4x3_integer_10847() {
    let (out, dropped, warnings) = convert("#5=IFCPROPERTYSINGLEVALUE('n',$,IFCCOUNTMEASURE(3.),$);", "IFC4", "IFC4X3");
    assert_eq!((out.as_str(), dropped, warnings.len()), ("#5=IFCPROPERTYSINGLEVALUE('n',$,IFCCOUNTMEASURE(3),$);", 0, 0));
    let (out, dropped, warnings) = convert("#5=IFCPROPERTYSINGLEVALUE('n',$,IFCCOUNTMEASURE(2.5),$);", "IFC4", "IFC4X3");
    assert_eq!((out.as_str(), dropped), ("#5=IFCPROPERTYSINGLEVALUE('n',$,$,$);", 1));
    assert_eq!(warnings, ["1 value(s) of a type the target slot does not accept were dropped: IFCPROPERTYSINGLEVALUE.NominalValue (#10847)."]);
    let integral = "#5=IFCPROPERTYSINGLEVALUE('n',$,IFCCOUNTMEASURE(3),$);";
    assert_eq!(convert(integral, "IFC4", "IFC4X3").0, integral);
    let (out, dropped, _) = convert("#5=IFCPROPERTYLISTVALUE('n',$,(IFCCOUNTMEASURE(2.),IFCCOUNTMEASURE(2.5)),$);", "IFC4", "IFC4X3");
    assert_eq!((out.as_str(), dropped), ("#5=IFCPROPERTYLISTVALUE('n',$,(IFCCOUNTMEASURE(2)),$);", 1));
    // From IFC2X3 too, and a positional member empties its group.
    assert_eq!(convert("#5=IFCPROPERTYSINGLEVALUE('n',$,IFCCOUNTMEASURE(4.),$);", "IFC2X3", "IFC4X3").0, "#5=IFCPROPERTYSINGLEVALUE('n',$,IFCCOUNTMEASURE(4),$);");
    assert_eq!(convert("#5=IFCTABLEROW((IFCCOUNTMEASURE(2.5),IFCLABEL('x')),.F.);", "IFC4", "IFC4X3").0, "#5=IFCTABLEROW($,.F.);");
    // IFC4X3 -> IFC4 widens IfcCountMeasure back to a number: nothing to convert.
    let integer = "#5=IFCPROPERTYSINGLEVALUE('n',$,IFCCOUNTMEASURE(3),$);";
    assert_eq!(convert(integer, "IFC4X3", "IFC4"), (integer.to_owned(), 0, Vec::<String>::new()));
}

#[test]
fn newer_ifc_value_keeps_its_step_string_on_downgrade_10879() {
    let input = "#5=IFCPROPERTYLISTVALUE('n',$,(IFCDATETIME('2026-11-20T10:30:00Z'),IFCURIREFERENCE('https://example.org/a''b'),IFCBINARY(\"0A\")),$);";
    let (out, dropped, _) = convert(input, "IFC4X3", "IFC2X3");
    assert_eq!(out, "#5=IFCPROPERTYLISTVALUE('n',$,(IFCTEXT('2026-11-20T10:30:00Z'),IFCTEXT('https://example.org/a''b')),$);");
    assert_eq!(dropped, 1);
}

#[test]
fn fractional_work_control_duration_requires_the_last_unit_10879() {
    for (duration, seconds) in [
        ("PT1.5H", "5400."), ("PT1H30.5M", "5430."), ("P0.5D", "43200."), ("P0.5W", "302400."),
        ("PT1.5H30M", "$"), ("P0.5DT1H", "$"),
    ] {
        let line = format!("#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,'{duration}',$,$,$,.ACTUAL.);");
        let (out, dropped, _) = convert(&line, "IFC4", "IFC2X3");
        assert_eq!(out, format!("#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,{seconds},$,$,$,.ACTUAL.,$);"), "{duration}");
        assert_eq!(dropped, usize::from(seconds == "$"), "{duration}");
    }
}

#[test]
fn work_control_durations_convert_exact_seconds_and_refuse_calendar_months_10879() {
    let upgrade = "#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,12.5,2.E-2,$,$,.ACTUAL.,$);";
    let (out, dropped, _) = convert(upgrade, "IFC2X3", "IFC4");
    assert_eq!((out.as_str(), dropped), ("#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,'PT12.5S','PT0.02S',$,$,.ACTUAL.);", 0));
    let down = "#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,'P1DT2H3M4.50S','P1M',$,$,.ACTUAL.);";
    let (out, dropped, _) = convert(down, "IFC4X3", "IFC2X3");
    assert_eq!((out.as_str(), dropped), ("#5=IFCWORKPLAN('g',$,'n',$,$,'id',$,$,$,93784.5,$,$,$,.ACTUAL.,$);", 1));
}

#[test]
fn calendar_dates_and_zoned_times_round_trip_10879() {
    let input = include_bytes!("../tests/fixtures/schema_calendar_dates.ifc");
    let up = crate::StepOptions { schema: Some("IFC4".to_owned()), ..Default::default() };
    let (up, stats, warnings) = crate::export_step_with_diagnostics(input, &up).unwrap();
    assert_eq!(stats.attribute_values_dropped, 1);
    assert!(warnings.iter().any(|warning| warning == "1 date value(s) kept the calendar date and dropped the time and any timezone: IFCCOSTVALUE.ApplicableDate (#10879)."), "{warnings:?}");
    assert!(up.contains("#1=IFCCLASSIFICATION('Source','1','2024-02-29','Classification',$,$,$);"), "{up}");
    assert!(up.contains("#3=IFCIRREGULARTIMESERIESVALUE('2024-02-29T10:30:15.5+05:30',(IFCREAL(1.)));"), "{up}");
    assert!(up.contains("#7=IFCCOSTVALUE('Estimate',$,$,$,'2024-02-29','2024-02-29','Materials',$,$,$);"), "{up}");
    for obsolete in ["IFCCALENDARDATE(", "IFCDATEANDTIME(", "IFCLOCALTIME(", "IFCCOORDINATEDUNIVERSALTIMEOFFSET("] {
        assert!(!up.contains(obsolete), "{up}");
    }
    let down = crate::StepOptions { schema: Some("IFC2X3".to_owned()), ..Default::default() };
    let step = crate::export_step(up.as_bytes(), &down).unwrap();
    let (log, _) = crate::export_step_with_log(up.as_bytes(), &down, &crate::MutationLog::default()).unwrap();
    let merged = crate::export_merged(&[up.as_bytes()], &crate::MergedOptions { schema: down.schema.clone(), ..Default::default() });
    for output in [&step, &log, &merged] {
        assert!(output.contains("IFCCALENDARDATE(29,2,2024);"), "{output}");
        assert!(output.contains("IFCLOCALTIME(10,30,15.5,#"), "{output}");
        assert!(output.contains("IFCCOORDINATEDUNIVERSALTIMEOFFSET(5,30,.AHEAD.);"), "{output}");
    }
}

#[test]
fn durations_warn_about_non_second_project_time_units_10879() {
    let input = include_bytes!("../tests/fixtures/schema_duration_timeunit.ifc");
    let upgrade = crate::StepOptions { schema: Some("IFC4".to_owned()), ..Default::default() };
    let modern = crate::export_step(input, &upgrade).unwrap();
    for (source, schema, expected) in [
        (input.as_slice(), "IFC4", ",'id',$,$,$,'PT10S',"),
        (modern.as_bytes(), "IFC2X3", ",'id',$,$,$,10.,"),
    ] {
        let options = crate::StepOptions { schema: Some(schema.to_owned()), ..Default::default() };
        let (direct, _, direct_warnings) = crate::export_step_with_diagnostics(source, &options).unwrap();
        let (logged, log) = crate::export_step_with_log(source, &options, &crate::MutationLog::default()).unwrap();
        let (merged, merge) = crate::export_merged_models(&[crate::MergedModel::new(source)], &crate::MergedOptions { schema: options.schema, ..Default::default() });
        for (output, warnings) in [(direct, direct_warnings), (logged, log.warnings), (merged, merge.warnings)] {
            assert!(output.contains(expected), "{output}");
            assert!(warnings.iter().any(|warning| warning.contains("assumed seconds")), "{warnings:?}");
        }
    }
    let seconds = std::str::from_utf8(input).unwrap().replace("IFCUNITASSIGNMENT((#6))", "IFCUNITASSIGNMENT((#3))");
    let (_, _, warnings) = crate::export_step_with_diagnostics(seconds.as_bytes(), &upgrade).unwrap();
    assert!(!warnings.iter().any(|warning| warning.contains("assumed seconds")), "{warnings:?}");
}


#[test]
fn commented_typed_date_keeps_its_text_on_downgrade_10879() {
    let line = "#5=IFCPROPERTYSINGLEVALUE('Date',$,IFCDATE(/* before */'2024-01-01'),$);";
    let (out, dropped, _) = convert(line, "IFC4", "IFC2X3");
    assert_eq!(out, "#5=IFCPROPERTYSINGLEVALUE('Date',$,IFCTEXT('2024-01-01'),$);");
    assert_eq!(dropped, 0);
}
