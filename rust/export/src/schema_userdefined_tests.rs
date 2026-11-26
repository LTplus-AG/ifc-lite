// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::schema_convert::convert_step_line;
use crate::schema_enum::ConversionChecks;
use crate::schema_ifc2x3_slots::Ifc2x3SlotFill;

/// The lists are the shared fixture (the TypeScript twin runs the same
/// comparison).
#[test]
fn the_exemptions_are_the_shared_fixture_10780() {
    let doc: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/schema_userdefined_rules.json")).expect("valid JSON");
    let labels: Vec<&str> = doc["labels"].as_array().expect("labels").iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(labels, LABELS);
    for (schema, list) in EXEMPT {
        let fixture: Vec<&str> = doc["exempt"][schema].as_array().expect(schema).iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(*list, fixture.as_slice(), "{schema}");
    }
}

/// One `ENTITY ... END_ENTITY;` block of an EXPRESS file, by uppercase name.
fn entities(exp: &str) -> std::collections::HashMap<String, &str> {
    exp.split("ENTITY ").skip(1).filter_map(|b| {
        let name = b.split(|c: char| !c.is_ascii_alphanumeric() && c != '_').next()?;
        Some((name.to_ascii_uppercase(), b.split("END_ENTITY;").next()?))
    }).collect()
}

/// True when `rule` names attribute `label` as a whole word, not inside an
/// enum name such as `IfcTransportElementTypeEnum`.
fn names_attribute(rule: &str, label: &str) -> bool {
    let word = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    rule.match_indices(label).any(|(i, _)| !word(rule[..i].chars().next_back()) && !word(rule[i + label.len()..].chars().next()))
}

/// Every non-abstract entity with PredefinedType and a label attribute either
/// has a WHERE rule tying USERDEFINED to that label, along its supertypes, or
/// is exempt: the list is re-derived from the EXPRESS files, not trusted.
#[test]
fn the_exemptions_are_exactly_the_entities_without_a_rule_10780() {
    let files = [
        ("IFC2X3", include_str!("../../../packages/codegen/schemas/IFC2X3_TC1.exp")),
        ("IFC4", include_str!("../../../packages/codegen/schemas/IFC4_ADD2_TC1.exp")),
        ("IFC4X3", include_str!("../../../packages/codegen/schemas/IFC4X3.exp")),
    ];
    for (schema, exp) in files {
        let bodies = entities(exp);
        let mut derived = Vec::new();
        let mut ruled = 0usize;
        for (name, body) in &bodies {
            let header = body.split(';').next().unwrap_or_default();
            if header.contains("ABSTRACT SUPERTYPE") { continue; }
            let Some(names) = ifc_lite_core::attribute_names_for_schema(schema, name) else { continue };
            let Some(label) = names.iter().find(|n| LABELS.contains(n)) else { continue };
            if !names.contains(&"PredefinedType") { continue; }
            let (mut current, mut rule) = (Some(name.clone()), false);
            while let Some(entity) = current.take() {
                let Some(body) = bodies.get(&entity) else { break };
                let wheres = body.lines().skip_while(|l| l.trim() != "WHERE").collect::<Vec<_>>().join("\n");
                rule |= wheres.split(';').any(|r| r.contains("USERDEFINED") && names_attribute(r, label));
                current = body.split("SUBTYPE OF").nth(1).and_then(|s| s.split(['(', ')']).nth(1)).map(|s| s.trim().to_ascii_uppercase());
            }
            if rule { ruled += 1 } else { derived.push(name.clone()) }
        }
        derived.sort();
        assert!(ruled > 30, "anti-vacuity: {schema} has {ruled} entities with the rule");
        let listed = EXEMPT.iter().find(|(s, _)| *s == schema).map(|(_, l)| *l).unwrap();
        assert_eq!(derived, listed, "{schema}");
    }
}

fn refused(line: &str, from: &str, to: &str) -> (String, usize, Vec<String>) {
    let mut checks = ConversionChecks::default();
    let out = convert_step_line(line, from, to, 5, &mut Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
    (out, checks.enums.refused(), checks.enums.warnings())
}

/// The issue's case: IFC2X3 IfcWorkPlan's WorkControlType becomes IFC4's
/// PredefinedType, `.USERDEFINED.` with ObjectType unset. With no IFC2X3 label
/// either it is reported, and nothing is invented; a set UserDefinedControlType
/// is carried into ObjectType (#10824), so that one is not.
#[test]
fn a_userdefined_record_without_its_label_is_reported_10780() {
    let line = "#5=IFCWORKPLAN('g',#2,'P',$,$,'WP-1',#3,(#4),$,$,$,#6,$,.USERDEFINED.,$);";
    let (out, n, warnings) = refused(line, "IFC2X3", "IFC4");
    assert!(out.contains(",.USERDEFINED.") && out.contains("'P',$,$,"), "{out}");
    assert_eq!(n, 1);
    assert!(warnings.iter().any(|w| w.contains("without the label their rule needs") && w.contains("IFCWORKPLAN")), "{warnings:?}");
    let labelled = line.replace("'P',$,$,", "'P',$,'Custom',");
    assert_eq!(refused(&labelled, "IFC2X3", "IFC4").1, 0, "ObjectType set");
    assert_eq!(refused(&line.replace(".USERDEFINED.,$);", ".USERDEFINED.,'Custom');"), "IFC2X3", "IFC4").1, 0, "the IFC2X3 label is carried (#10824)");
}

#[test]
fn only_a_type_with_the_rule_is_reported_10780() {
    assert_eq!(refused("#5=IFCWALL('g',$,$,$,$,$,$,$,.USERDEFINED.);", "IFC4X3", "IFC4").1, 1);
    assert_eq!(refused("#5=IFCWALL('g',$,$,$,'Mine',$,$,$,.USERDEFINED.);", "IFC4X3", "IFC4").1, 0);
    assert_eq!(refused("#5=IFCWALL('g',$,$,$,$,$,$,$,.STANDARD.);", "IFC4X3", "IFC4").1, 0);
    assert_eq!(refused("#5=IFCWALL('g',$,$,$,/* none */$,$,$,$,.USERDEFINED. /* x */);", "IFC4X3", "IFC4").1, 1, "comments are trivia");
    assert_eq!(refused("#5=IFCWALL('g',$,$,$,'Mine' /* x */,$,$,$,.USERDEFINED.);", "IFC4X3", "IFC4").1, 0);
    // IFC4 IfcDoor's PredefinedType has no such rule.
    assert_eq!(refused("#5=IFCDOOR('g',$,$,$,$,$,$,$,$,$,.USERDEFINED.,$,$);", "IFC4X3", "IFC4").1, 0);
}

#[test]
fn reports_ifc2x3_userdefined_enum_and_label_pairs_11006() {
    for (ty, source) in [
        ("IFCWORKPLAN", "#7=IFCWORKPLAN('g',#2,'P',$,$,'WP',$,$,$,$,$,$,$,.USERDEFINED.);"),
        ("IFCWORKSCHEDULE", "#7=IFCWORKSCHEDULE('g',#2,'S',$,$,'WS',$,$,$,$,$,$,$,.USERDEFINED.);"),
        ("IFCPROCEDURE", "#7=IFCPROCEDURE('g',#2,'P',$,$,'P-1',$,.USERDEFINED.);"),
        ("IFCELECTRICDISTRIBUTIONPOINT", "#7=IFCELECTRICDISTRIBUTIONBOARD('g',#2,'b',$,$,$,$,'t',.USERDEFINED.);"),
    ] {
        let (_, count, warnings) = refused(source, "IFC4", "IFC2X3");
        assert_eq!(count, 1, "{ty}: {warnings:?}");
        assert!(warnings.iter().any(|w| w.contains(ty) && w.contains("without the label")), "{warnings:?}");
        let set = source.replacen("',$,$,", "',$,'Custom',", 1);
        assert_eq!(refused(&set, "IFC4", "IFC2X3").1, 0, "{ty}");
    }
}

#[test]
fn reports_star_beside_a_comment_as_an_unset_label_11006() {
    let line = "#7=IFCSLAB('g',#2,$,$,/* unset */*,$,$,$,.USERDEFINED.);";
    let (_, count, _) = refused(line, "IFC4X3", "IFC4");
    assert_eq!(count, 1);
}

#[test]
fn uses_userdefined_control_type_for_an_unrecognized_member_11006() {
    let line = "#7=IFCWORKPLAN('g',#2,'P',$,$,'WP',$,$,$,$,$,$,$,.CUSTOMPLAN.);";
    let (out, count, _) = refused(line, "IFC4", "IFC2X3");
    assert!(out.ends_with(",.USERDEFINED.,'CUSTOMPLAN');"), "{out}");
    assert_eq!(count, 0);
}

#[test]
fn fills_commented_unset_userdefined_control_type_11006() {
    for unset in ["$", "*"] {
        let line = format!("#7=IFCWORKPLAN('g',#2,'P',$,$,'WP',$,$,$,$,$,$,$,.CUSTOMPLAN.,/* unset */{unset});");
        let mut checks = ConversionChecks::default();
        let out = checks.enums.apply(line, "IFC2X3");
        assert!(out.ends_with(",.USERDEFINED.,'CUSTOMPLAN');"), "{out}");
        let warnings = checks.enums.warnings();
        assert!(warnings.is_empty(), "{warnings:?}");
    }
}
