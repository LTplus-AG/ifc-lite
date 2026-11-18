// SPDX-License-Identifier: MPL-2.0
//! Mirrors the CausedBy cases of `packages/export/src/schema-converter-structural-carriers.test.ts` (#9668, #10597).
use crate::step::{export_step_with_diagnostics, StepOptions};

const OWNER: &str = "#1=IFCPERSON($,'P',$,$,$,$,$,$);
#2=IFCORGANIZATION($,'O',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'1','A','A');
#5=IFCOWNERHISTORY(#3,#4,$,.NOCHANGE.,$,$,$,1);
#6=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',#5,'P',$,$,$,$,$,$);
#7=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#9=IFCLOCALPLACEMENT($,#8);
#10=IFCLOCALPLACEMENT($,#8);
#11=IFCSTRUCTURALLOADLINEARFORCE('line',0.,0.,-5.,0.,0.,0.);
#12=IFCSTRUCTURALLOADSINGLEDISPLACEMENT('disp',0.,0.,-0.001,0.,0.,0.);";

const REACTION: &str = "#20=IFCSTRUCTURALPOINTREACTION('0KQ0efL39PrP5DeqBwaUNp',#5,'R',$,$,#9,$,#12,.GLOBAL_COORDS.);";
const REACTION_2: &str = "#23=IFCSTRUCTURALPOINTREACTION('1KQ0efL39PrP5DeqBwaUNp',#5,'R2',$,$,#9,$,#12,.GLOBAL_COORDS.);";
const CAUSED: &str = "#21=IFCSTRUCTURALLINEARACTION('2CpCw3$DzVlut_KQsd7u6Y',#5,'A',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,#20,.TRUE_LENGTH.);";
const UNCAUSED: &str = "#22=IFCSTRUCTURALLINEARACTION('3nopC4uRTI$9OB7Ig1TJsz',#5,'B',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.);";

fn model(schema: &str, data: &str) -> String {
    format!("ISO-10303-21;HEADER;FILE_SCHEMA(('{schema}'));ENDSEC;DATA;\n{OWNER}\n{data}\nENDSEC;END-ISO-10303-21;")
}
fn convert(source: &str, schema: &str) -> (String, String) {
    let (out, _, warnings) = export_step_with_diagnostics(source.as_bytes(), &StepOptions { schema: Some(schema.into()), ..StepOptions::default() }).unwrap();
    (out, warnings.join("\n"))
}
fn record(out: &str, id: u32) -> String { out.lines().find(|l| l.starts_with(&format!("#{id}="))).unwrap_or_default().to_string() }
fn relationships(out: &str) -> Vec<&str> { out.lines().filter(|l| l.contains("=IFCRELASSIGNSTOPRODUCT(")).collect() }

#[test]
fn writes_caused_by_as_causes_and_reads_it_back_9668() {
    let (up, warnings) = convert(&model("IFC2X3", &[REACTION, CAUSED, UNCAUSED].join("\n")), "IFC4");
    assert_eq!(record(&up, 21), "#21=IFCSTRUCTURALLINEARACTION('2CpCw3$DzVlut_KQsd7u6Y',#5,'A',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);");
    let rels = relationships(&up);
    assert_eq!(rels.len(), 1, "{up}");
    assert!(rels[0].ends_with(",#5,'Causes',$,(#20),$,#21);"), "{}", rels[0]);
    assert!(warnings.contains("IFC2X3 CausedBy is written as an IfcRelAssignsToProduct named 'Causes'"), "{warnings}");
    assert!(!warnings.contains("CausedBy has no slot in IFC4"), "{warnings}");

    let (down, warnings) = convert(&up, "IFC2X3");
    assert!(record(&down, 21).ends_with(",.F.,#20,.TRUE_LENGTH.);"), "{down}");
    assert!(record(&down, 22).ends_with(",.F.,$,.TRUE_LENGTH.);"), "{down}");
    assert!(warnings.contains("also fills the IFC2X3 CausedBy"), "{warnings}");
    // IFC2X3 has the relationship too; it is kept, and a second upgrade does not duplicate it.
    assert_eq!(relationships(&down).len(), 1);
    assert_eq!(relationships(&convert(&down, "IFC4").0).len(), 1);
}

#[test]
fn finds_a_source_causes_whatever_its_related_objects_type_9668() {
    let rel = "#40=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',#5,'Causes',$,(#20),.PRODUCT.,#21);";
    assert_eq!(relationships(&convert(&model("IFC2X3", &[REACTION, CAUSED, rel, UNCAUSED].join("\n")), "IFC4").0).len(), 1);
}

#[test]
fn reads_two_causes_naming_the_same_reaction_as_one_cause_9668() {
    let source = model("IFC4", &[REACTION,
        "#21=IFCSTRUCTURALLINEARACTION('2CpCw3$DzVlut_KQsd7u6Y',#5,'A',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);",
        "#30=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',#5,'Causes',$,(#20),$,#21);",
        "#31=IFCRELASSIGNSTOPRODUCT('1bbbbbbbbbbbbbbbbbbbbb',#5,'Causes',$,(#20),$,#21);"].join("\n"));
    assert!(record(&convert(&source, "IFC2X3").0, 21).ends_with(",.F.,#20,.TRUE_LENGTH.);"));
}

#[test]
fn fills_caused_by_only_from_one_relationship_naming_one_point_reaction_9668() {
    let action = |id: u32, name: &str| format!("#{id}=IFCSTRUCTURALLINEARACTION('{id}CpCw3$DzVlut_KQsd7u6Y',#5,'{name}',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);");
    let source = model("IFC4", &[REACTION.to_string(), REACTION_2.to_string(), action(21, "A"), action(22, "B"), action(24, "C"),
        "#30=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',#5,'Causes',$,(#20,#23),$,#21);".into(),
        "#31=IFCRELASSIGNSTOPRODUCT('1bbbbbbbbbbbbbbbbbbbbb',#5,'Other',$,(#20),$,#22);".into(),
        "#32=IFCRELASSIGNSTOPRODUCT('1ccccccccccccccccccccc',#5,'Causes',$,(#23),$,#24);".into()].join("\n"));
    let (down, _) = convert(&source, "IFC2X3");
    assert!(record(&down, 21).ends_with(",.F.,$,.TRUE_LENGTH.);"), "{down}");
    assert!(record(&down, 22).ends_with(",.F.,$,.TRUE_LENGTH.);"), "{down}");
    assert!(record(&down, 24).ends_with(",.F.,#23,.TRUE_LENGTH.);"), "{down}");
    assert_eq!(relationships(&down).len(), 3);
}

#[test]
fn keeps_caused_by_beside_a_source_causes_naming_another_reaction_9668() {
    let rel = "#30=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',#5,'Causes',$,(#23),$,#21);";
    let (up, warnings) = convert(&model("IFC2X3", &[REACTION, REACTION_2, CAUSED, rel].join("\n")), "IFC4");
    let rels = relationships(&up);
    assert_eq!(rels.len(), 2, "{up}");
    assert!(rels[0].starts_with("#30=") && rels[1].ends_with("'Causes',$,(#20),$,#21);"), "{rels:?}");
    assert!(warnings.contains("IFC2X3 CausedBy is one of several reactions"), "{warnings}");
    assert!(!warnings.contains("CausedBy has no slot in IFC4") && !warnings.contains("CausedBy is written as"), "{warnings}");
    // Back in IFC2X3 the action has two causes, so CausedBy stays unset and both relationships stay.
    let (down, _) = convert(&up, "IFC2X3");
    assert!(record(&down, 21).ends_with(",.F.,$,.TRUE_LENGTH.);"), "{down}");
    assert_eq!(relationships(&down).len(), 2);

    // A source relationship naming the reaction among others: no second one, and still not restorable.
    let (up, warnings) = convert(&model("IFC2X3", &[REACTION, REACTION_2, CAUSED, &rel.replace("(#23)", "(#20,#23)")].join("\n")), "IFC4");
    assert_eq!(relationships(&up), ["#30=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',#5,'Causes',$,(#20,#23),$,#21);"]);
    assert!(warnings.contains("IFC2X3 CausedBy is one of several reactions"), "{warnings}");
}

#[test]
fn writes_causes_even_when_another_actions_names_the_same_reaction_9668() {
    let rel = "#30=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',#5,'Causes',$,(#20),$,#22);";
    let (up, warnings) = convert(&model("IFC2X3", &[REACTION, CAUSED, UNCAUSED, rel].join("\n")), "IFC4");
    let rels = relationships(&up);
    assert_eq!(rels.len(), 2, "{up}");
    assert!(rels[1].ends_with("'Causes',$,(#20),$,#21);"), "{rels:?}");
    assert!(warnings.contains("IFC2X3 CausedBy is written as"), "{warnings}");
}

#[test]
fn writes_no_causes_for_a_caused_by_that_names_no_reaction_9668() {
    let (up, warnings) = convert(&model("IFC2X3", &CAUSED.replace(",.F.,#20,", ",.F.,#9,")), "IFC4");
    assert!(relationships(&up).is_empty(), "{up}");
    assert!(warnings.contains("IFCSTRUCTURALLINEARACTION.CausedBy has no slot in IFC4; its value is omitted"), "{warnings}");
}

// A varying action that stays unconverted is no IFC4 product, so no 'Causes' relationship may name it.
const GEOMETRY: &str = "#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#14=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#17=IFCSHAPEASPECT((#16),'Coverage aspect',$,.T.,#15);";
const VARYING: &str = "#30=IFCSTRUCTURALLINEARACTIONVARYING('3sXjCM_kPHN8ZCpuBhV_98',#5,'V',$,$,#9,#15,#11,.GLOBAL_COORDS.,.F.,#20,.TRUE_LENGTH.,#17,(#11,#11));";

#[test]
fn an_unconverted_varying_action_gets_no_causes_9668() {
    let (up, warnings) = convert(&model("IFC2X3", &[GEOMETRY, REACTION, VARYING].join("\n")), "IFC4");
    assert!(record(&up, 30).starts_with("#30=IFCSTRUCTURALLINEARACTIONVARYING("), "{up}");
    assert!(relationships(&up).is_empty(), "{up}");
    assert!(warnings.contains("CausedBy of a varying action that stays unconverted is kept only in that IFC2X3 record"), "{warnings}");
    assert!(!warnings.contains("CausedBy is written as"), "{warnings}");
}

#[test]
fn a_converted_varying_action_gets_causes_before_its_configuration_9668() {
    let geometry = GEOMETRY.replace("IFCSHAPEASPECT((#16),", "IFCSHAPEASPECT((#14,#16,#16),");
    let (up, warnings) = convert(&model("IFC2X3", &[geometry.as_str(), REACTION, VARYING].join("\n")), "IFC4");
    // The TypeScript twin allocates the relationship first (#31), then the configuration (#32), and appends configurations first.
    assert!(record(&up, 30).starts_with("#30=IFCSTRUCTURALCURVEACTION(") && record(&up, 30).contains(",#15,#32,"), "{up}");
    assert_eq!(relationships(&up).len(), 1);
    assert!(relationships(&up)[0].starts_with("#31=") && relationships(&up)[0].ends_with("'Causes',$,(#20),$,#30);"), "{up}");
    let tail: Vec<&str> = up.lines().filter(|l| l.starts_with("#31=") || l.starts_with("#32=")).collect();
    assert!(tail[0].starts_with("#32=IFCSTRUCTURALLOADCONFIGURATION(") && tail[1].starts_with("#31="), "{tail:?}");
    assert!(warnings.contains("CausedBy is written as") && !warnings.contains("CausedBy has no slot"), "{warnings}");
}

#[test]
fn reads_causes_and_unset_slots_with_step_comments_10248() {
    // A comment around the Name: the source relationship is found, so no second one is written.
    let rel = "#40=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',#5, /*n*/ 'Causes' ,$,(#20),$,#21);";
    assert_eq!(relationships(&convert(&model("IFC2X3", &[REACTION, CAUSED, rel].join("\n")), "IFC4").0).len(), 1);
    // And on the way down it fills CausedBy.
    let source = model("IFC4", &[REACTION,
        "#21=IFCSTRUCTURALLINEARACTION('2CpCw3$DzVlut_KQsd7u6Y',#5,'A',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);",
        "#30=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',#5,/*n*/'Causes',$,(#20),$,#21);"].join("\n"));
    assert!(record(&convert(&source, "IFC2X3").0, 21).ends_with(",.F.,#20,.TRUE_LENGTH.);"));
}

#[test]
fn reports_caused_by_lost_when_no_id_is_left_for_its_relationship_10597() {
    let mut checks = crate::schema_enum::ConversionChecks::new();
    let source = model("IFC2X3", &[REACTION, CAUSED].join("\n"));
    checks.structural.carriers = super::StructuralCarriers::scan_ifc2x3(source.as_bytes(), |_, _| true);
    checks.structural.allocate(|| None);
    let line = CAUSED.to_string();
    crate::schema_convert::convert_step_line(&line, "IFC2X3", "IFC4", 21, &mut crate::schema_ifc2x3_slots::Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
    assert!(checks.structural.added().is_empty());
    let warnings = checks.structural.warnings().join("\n");
    assert!(warnings.contains("IFCSTRUCTURALLINEARACTION.CausedBy has no slot in IFC4"), "{warnings}");
    assert!(!warnings.contains("CausedBy is written as"), "{warnings}");
}

#[test]
fn commented_varying_action_converts_before_its_causes_is_written_10597() {
    let geometry = GEOMETRY.replace("IFCSHAPEASPECT((#16),", "IFCSHAPEASPECT((#14,#16,#16),");
    let action = VARYING.replace("ACTIONVARYING(", "ACTIONVARYING /* note ( */ (");
    let (up, _) = convert(&model("IFC2X3", &[&geometry, REACTION, &action].join("\n")), "IFC4");
    assert!(record(&up, 30).starts_with("#30=IFCSTRUCTURALCURVEACTION("), "{up}");
    assert!(relationships(&up)[0].ends_with("'Causes',$,(#20),$,#30);"), "{up}");
}

#[test]
fn the_last_id_goes_to_the_varying_load_configuration_10597() {
    let geometry = GEOMETRY.replace("IFCSHAPEASPECT((#16),", "IFCSHAPEASPECT((#14,#16,#16),");
    let source = model("IFC2X3", &[&geometry, REACTION, VARYING, "#4294967294=IFCCARTESIANPOINT((0.,0.,0.));"].join("\n"));
    let (up, warnings) = convert(&source, "IFC4");
    assert!(record(&up, 30).starts_with("#30=IFCSTRUCTURALCURVEACTION(") && record(&up, 30).contains(",#4294967295,"), "{up}");
    assert!(record(&up, u32::MAX).starts_with("#4294967295=IFCSTRUCTURALLOADCONFIGURATION("), "{up}");
    assert!(relationships(&up).is_empty(), "{up}");
    assert!(warnings.contains("CausedBy has no slot"), "{warnings}");
}

#[test]
fn the_loss_counter_only_counts_uncarried_caused_by_10597() {
    let point = "#24=IFCSTRUCTURALPOINTACTION('3nopC4uRTI$9OB7Ig1TJsz',#5,'B',$,$,#9,$,#12,.GLOBAL_COORDS.,.F.,#20);";
    let opts = StepOptions { schema: Some("IFC4".into()), ..StepOptions::default() };
    for action in [CAUSED, point] {
        for (data, expected) in [[REACTION, action], [REACTION, &action.replace("#20", "#999")]].into_iter().zip([0, 1]) {
            let source = model("IFC2X3", &data.join("\n"));
            let (_, stats, _) = export_step_with_diagnostics(source.as_bytes(), &opts).unwrap();
            assert_eq!(stats.attribute_values_dropped, expected, "{source}");
        }
    }
}
