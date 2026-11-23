// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::schema_convert::convert_step_line;
use crate::schema_enum::ConversionChecks;
use crate::schema_ifc2x3_slots::Ifc2x3SlotFill;
use ifc_lite_core::attribute_names_for_schema;

/// The table is the shared fixture, entry for entry (the TypeScript twin runs
/// the same comparison).
#[test]
fn the_table_is_the_shared_fixture_10763() {
    let mut doc: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/schema_attribute_maps.json")).expect("valid JSON");
    let fixture = doc["maps"].as_array_mut().expect("maps");
    fixture.iter_mut().for_each(|m| drop(m.as_object_mut().expect("map").remove("why")));
    assert!(ATTR_MAPS.len() >= 20, "anti-vacuity");
    assert_eq!(serde_json::to_value(ATTR_MAPS).expect("serializes"), doc["maps"]);
}

/// Every name a map lists sits on the side it is listed for in core's
/// registry, IFC4X3 declares the IFC4 list, and no map covers a pair a trim or
/// pad already handles.
#[test]
fn every_map_names_real_attributes_and_a_non_prefix_pair_10763() {
    for m in ATTR_MAPS {
        let old = attribute_names_for_schema("IFC2X3", m.ifc2x3).unwrap_or_else(|| panic!("{} in IFC2X3", m.ifc2x3));
        let new = attribute_names_for_schema("IFC4", m.ifc4).unwrap_or_else(|| panic!("{} in IFC4", m.ifc4));
        assert_eq!(attribute_names_for_schema("IFC4X3", m.ifc4), Some(new), "{}: IFC4X3 declares the IFC4 list", m.ifc4);
        let pairs = m.renamed.iter().chain(m.set_of_one.as_ref());
        for (a, b) in pairs {
            assert!(old.contains(a) && new.contains(b), "{}: {a} -> {b}", m.ifc4);
        }
        for name in m.retyped.iter().chain(m.up_only) {
            assert!(old.contains(name) && new.contains(name), "{}: {name} is in both lists", m.ifc4);
        }
        let prefix = |a: &[&str], b: &[&str]| a.len() < b.len() && b.starts_with(a);
        assert!(!prefix(old, new) && !prefix(new, old) && old != new, "{}: a prefix pair needs no map", m.ifc4);
    }
}

fn up(line: &str) -> String {
    convert_step_line(line, "IFC2X3", "IFC4", 1, &mut Ifc2x3SlotFill::new(None), None).unwrap()
}

fn down(line: &str) -> String {
    convert_step_line(line, "IFC4", "IFC2X3", 1, &mut Ifc2x3SlotFill::new(None), None).unwrap()
}

/// The issue's example: before #10763 the description landed in `Identifier`
/// and the record stayed seven slots long.
#[test]
fn ifc_approval_carries_each_value_to_its_own_slot_10763() {
    let src = "#5=IFCAPPROVAL('desc',#9,'Approved','L1','Q','Name','Id');";
    assert_eq!(up(src), "#5=IFCAPPROVAL('Id','Name','desc',$,'Approved','L1','Q',$,$);");
    // ApprovalDateTime is required in IFC2X3 and has no source; it stays $.
    let ifc4 = "#5=IFCAPPROVAL('Id','Name','desc','2020-01-01','Approved','L1','Q',#7,#8);";
    assert_eq!(down(ifc4), "#5=IFCAPPROVAL('desc',$,'Approved','L1','Q','Name','Id');");
}

#[test]
fn a_single_reference_becomes_a_set_and_back_10763() {
    assert_eq!(up("#5=IFCAPPROVALRELATIONSHIP(#3,#4,'d','n');"), "#5=IFCAPPROVALRELATIONSHIP('n','d',#4,(#3));");
    assert_eq!(down("#5=IFCAPPROVALRELATIONSHIP('n','d',#4,(#3));"), "#5=IFCAPPROVALRELATIONSHIP(#3,#4,'d','n');");
}

/// #10763, PR #10781: narrowing RelatedApprovals keeps exactly one held
/// value. Comments and omitted items do not contribute to the loss.
#[test]
fn approval_relationship_counts_only_discarded_members_10781() {
    let cases = ["(#3)", "(#3,#6,#7)", "/* before */(#3,/* empty */$)/* after */"];
    let counts = cases.map(|related| {
        let source = format!("#5=IFCAPPROVALRELATIONSHIP('n','d',#4,{related});");
        let mut checks = ConversionChecks::default();
        let out = convert_step_line(&source, "IFC4", "IFC2X3", 5, &mut Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
        assert_eq!(out, "#5=IFCAPPROVALRELATIONSHIP(#3,#4,'d','n');");
        checks.attribute_values_dropped
    });
    assert_eq!(counts, [0, 2, 0]);
}

#[test]
fn objective_downgrade_drops_benchmark_values_even_if_singleton_10807() {
    let cases = ["$", "(#20)", "(#20,#21)"];
    let outcomes = cases.map(|benchmark| {
        let source = format!("#5=IFCOBJECTIVE('id',$,'Objective',$,$,$,$,{benchmark},$,$,$);");
        let mut checks = ConversionChecks::default();
        let out = convert_step_line(&source, "IFC4", "IFC2X3", 5, &mut Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
        (out, checks.attribute_values_dropped)
    });
    assert_eq!(outcomes[1], (outcomes[0].0.clone(), outcomes[0].1 + 1));
    assert_eq!(outcomes[2], (outcomes[0].0.clone(), outcomes[0].1 + 1));
}

/// What each direction cannot carry is counted, including the members of a
/// SET past the first, and an up-only reference is dropped on the way down.
#[test]
fn every_value_without_a_target_slot_is_counted_10763() {
    let dropped = |line: &str, from: &str, to: &str| {
        let mut checks = ConversionChecks::default();
        let out = convert_step_line(line, from, to, 1, &mut Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
        (out, checks.attribute_values_dropped)
    };
    let (out, n) = dropped("#5=IFCAPPROVALRELATIONSHIP('n','d',#4,(#3,#6,#7));", "IFC4", "IFC2X3");
    assert_eq!((out.as_str(), n), ("#5=IFCAPPROVALRELATIONSHIP(#3,#4,'d','n');", 2));
    let (out, n) = dropped("#5=IFCLIBRARYINFORMATION('n','v',#3,'2020-01-01','https://x',$);", "IFC4", "IFC2X3");
    assert_eq!((out.as_str(), n), ("#5=IFCLIBRARYINFORMATION('n','v',$,$,$);", 3));
    let (out, n) = dropped("#5=IFCLIBRARYINFORMATION('n','v',#3,#4,(#6));", "IFC2X3", "IFC4");
    assert_eq!((out.as_str(), n), ("#5=IFCLIBRARYINFORMATION('n','v',#3,$,$,$);", 2));
}

/// IFC4 deleted IfcGeneralProfileProperties for a concrete
/// IfcProfileProperties; IFC2X3 cannot instantiate its abstract namesake.
#[test]
fn ifc4_profile_properties_downgrade_to_the_deleted_subtype_10763() {
    assert_eq!(
        convert_step_line("#5=IFCPROFILEPROPERTIES('n',$,(#6),#8);", "IFC4X3", "IFC2X3", 1, &mut Ifc2x3SlotFill::new(None), None).unwrap(),
        "#5=IFCGENERALPROFILEPROPERTIES($,#8,$,$,$,$,$);"
    );
}

/// A mapped upgrade that leaves an IFC4-required slot `$` is counted, which
/// the IFC2X3 -> IFC4 path otherwise skips.
#[test]
fn a_required_ifc4_slot_with_no_source_is_counted_10763() {
    let mut checks = ConversionChecks::default();
    let out = convert_step_line("#5=IFCTEXTUREMAP((#6));", "IFC2X3", "IFC4", 5, &mut Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
    assert_eq!(out, "#5=IFCTEXTUREMAP($,$,$);");
    assert_eq!(checks.ifc4_slots.required_slots_unfilled(), 3);
    assert_eq!(checks.attribute_values_dropped, 1);
}

#[test]
fn first_member_reads_a_list_and_passes_anything_else_through_10763() {
    assert_eq!(first_member("( #3 , #4 )"), ("#3", 1));
    assert_eq!(first_member("#3"), ("#3", 0));
    assert_eq!(first_member("()"), ("$", 0));
}

/// A SET slot is rebuilt without its comments, so a comment before, after or
/// inside it neither hides the list nor counts as a member.
#[test]
fn comments_around_a_set_are_dropped_when_it_is_rebuilt_10763() {
    assert_eq!(down("#5=IFCAPPROVALRELATIONSHIP('n','d',#4,/* a */(#3,#6)/* b */);"), "#5=IFCAPPROVALRELATIONSHIP(#3,#4,'d','n');");
    assert_eq!(down("#5=IFCAPPROVALRELATIONSHIP('n','d',#4,(/* c */$,#6));"), "#5=IFCAPPROVALRELATIONSHIP(#6,#4,'d','n');");
    assert_eq!(up("#5=IFCAPPROVALRELATIONSHIP(/* c */(#3),#4,'d','n');"), "#5=IFCAPPROVALRELATIONSHIP('n','d',#4,(#3));");
    assert_eq!(up("#5=IFCAPPROVALRELATIONSHIP(#3 /* x */,#4,'d','n');"), "#5=IFCAPPROVALRELATIONSHIP('n','d',#4,(#3));");
}

/// #10779: the TypeScript twin writes the same `$` for a slot holding only a
/// comment and `$`.
#[test]
fn a_comment_beside_no_value_is_carried_as_no_value_10779() {
    assert_eq!(up("#5=IFCAPPROVAL(/* none */$,#9,$,$,$,'Name','Id');"), "#5=IFCAPPROVAL('Id','Name',$,$,$,$,$,$,$);");
}

#[test]
fn unused_approval_datetime_counts_only_a_present_value_10779() {
    for (slot, dropped) in [("/* none */$", 0), ("#9", 1)] {
        let source = format!("#5=IFCAPPROVAL('desc',{slot},$,$,$,'Name','Id');");
        let mut checks = ConversionChecks::default();
        let out = convert_step_line(&source, "IFC2X3", "IFC4", 5, &mut Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
        assert_eq!(out, "#5=IFCAPPROVAL('Id','Name','desc',$,$,$,$,$,$);");
        assert_eq!(checks.attribute_values_dropped, dropped, "{slot}");
    }
}

/// #10777: an upgrade writes the IFC2X3 subtypes IFC4 deleted as the IFC4
/// supertype. A typed subtype keeps only `Material`; every measure is counted
/// dropped, and the required `Properties` left `$` is counted.
#[test]
fn ifc2x3_property_subtypes_upgrade_to_the_ifc4_supertype_10777() {
    assert_eq!(up("#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6,#7),'d','Pset_x');"), "#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6,#7),#8);");
    let mut checks = ConversionChecks::default();
    let line = "#5=IFCMECHANICALMATERIALPROPERTIES(#8,$,2.1E11,8.1E10,0.3,1.2E-5);";
    let out = convert_step_line(line, "IFC2X3", "IFC4", 5, &mut Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
    assert_eq!(out, "#5=IFCMATERIALPROPERTIES($,$,$,#8);");
    assert_eq!(checks.attribute_values_dropped, 4, "YoungModulus, ShearModulus, PoissonRatio, ThermalExpansionCoefficient");
    assert_eq!(checks.ifc4_slots.required_slots_unfilled(), 1, "Properties");
    let profile = convert_step_line("#5=IFCSTRUCTURALSTEELPROFILEPROPERTIES('P',#9,12.5,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);", "IFC2X3", "IFC4X3", 5, &mut Ifc2x3SlotFill::new(None), None).unwrap();
    assert_eq!(profile, "#5=IFCPROFILEPROPERTIES($,$,$,#9);");
    // IFC5 has no attribute list to map onto, so the record keeps its IFC2X3 name and layout.
    let ifc5 = "#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6,#7),'d','Pset_x');";
    assert_eq!(convert_step_line(ifc5, "IFC2X3", "IFC5", 5, &mut Ifc2x3SlotFill::new(None), None).unwrap(), ifc5);
}

#[test]
fn keeps_typed_ifc2x3_measures_as_property_single_values_10797() {
    let source = include_bytes!("../tests/fixtures/schema_typed_properties_upgrade.ifc");
    for schema in ["IFC4", "IFC4X3"] {
        let opts = crate::StepOptions { schema: Some(schema.to_owned()), ..Default::default() };
        let (output, stats, _) = crate::export_step_with_diagnostics(source, &opts).unwrap();
        let (logged, log_stats) = crate::export_step_with_log(source, &opts, &crate::MutationLog::default()).unwrap();
        let merged = crate::export_merged(&[source], &crate::MergedOptions { schema: opts.schema.clone(), ..Default::default() });
        for output in [&output, &logged, &merged] {
            for text in [
                "#2=IFCMATERIALPROPERTIES('Pset_MaterialConcrete',$,(",
                "IFCMATERIALPROPERTIES('Pset_MaterialMechanical',$,(",
                "#4=IFCPROFILEPROPERTIES('Pset_ProfileMechanical',$,(",
                "IFCPROPERTYSINGLEVALUE('YoungModulus',$,IFCMODULUSOFELASTICITYMEASURE(25000000000.),$);",
                "IFCPROPERTYSINGLEVALUE('CompressiveStrength',$,IFCPRESSUREMEASURE(30000000.),$);",
                "IFCPROPERTYSINGLEVALUE('MassPerLength',$,IFCMASSPERLENGTHMEASURE(4.5),$);",
            ] {
                assert!(output.contains(text), "{schema}: {text}\n{output}");
            }
        }
        assert_eq!(log_stats.new_entities, 9, "{schema}: eight values and one extra property set");
        assert_eq!(logged.lines().filter(|line| line.starts_with('#')).count(),
            log_stats.total + log_stats.new_entities, "{schema}");
        assert_eq!(log_stats.step.attribute_values_dropped, 0);
        assert_eq!(stats.attribute_values_dropped, 0);
    }
}

#[test]
fn latin1_data_keeps_typed_mass_density_in_all_step_writers_10797() {
    let source = include_bytes!("../tests/fixtures/schema_typed_properties_latin1.ifc");
    assert!(source.windows(5).any(|name| name == b"B\xe9ton"), "fixture must contain the raw Latin-1 name");
    let opts = crate::StepOptions { schema: Some("IFC4".to_owned()), ..Default::default() };
    let direct = crate::export_step(source, &opts).unwrap();
    let (logged, _) = crate::export_step_with_log(source, &opts, &crate::MutationLog::default()).unwrap();
    let merged = crate::export_merged(&[source], &crate::MergedOptions { schema: opts.schema, ..Default::default() });
    for (writer, output) in [("direct", direct), ("logged", logged), ("merged", merged)] {
        assert!(output.contains("IFCMATERIAL('B�ton',$,$);"), "{writer} changed unrelated record decoding:\n{output}");
        assert!(output.contains("IFCPROPERTYSINGLEVALUE('MassDensity',$,IFCMASSDENSITYMEASURE(42.),$);"),
            "{writer} dropped MassDensity:\n{output}");
    }
}

#[test]
fn shared_typed_property_records_match_every_step_writer_10797() {
    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        source: String,
        expected: Vec<String>,
    }
    let cases: Vec<Case> = serde_json::from_str(include_str!(
        "../tests/fixtures/schema_typed_properties_writer_vectors.json"
    )).unwrap();
    let opts = crate::StepOptions { schema: Some("IFC4".to_owned()), ..Default::default() };
    let merge_opts = crate::MergedOptions { schema: opts.schema.clone(), ..Default::default() };
    let mut failures = Vec::new();
    for case in cases {
        let input = format!("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n", case.source);
        let input: Vec<u8> = input.chars().map(|c| u8::try_from(u32::from(c)).unwrap()).collect();
        let direct = crate::export_step(&input, &opts).unwrap();
        let (logged, _) = crate::export_step_with_log(&input, &opts, &crate::MutationLog::default()).unwrap();
        let merged = crate::export_merged(&[&input], &merge_opts);
        for (writer, output) in [("direct", direct), ("logged", logged), ("merged", merged)] {
            for expected in &case.expected {
                if !output.lines().filter_map(|line| line.split_once('=')).any(|(_, body)| body == expected) {
                    failures.push(format!("{writer} {}: missing {expected}", case.name));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
