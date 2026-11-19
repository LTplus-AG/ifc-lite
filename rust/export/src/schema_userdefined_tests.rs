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
/// PredefinedType, `.USERDEFINED.` with ObjectType unset. It is reported, and
/// nothing is invented.
#[test]
fn a_userdefined_record_without_its_label_is_reported_10780() {
    let line = "#5=IFCWORKPLAN('g',#2,'P',$,$,'WP-1',#3,(#4),$,$,$,#6,$,.USERDEFINED.,'Custom');";
    let (out, n, warnings) = refused(line, "IFC2X3", "IFC4");
    assert!(out.contains(",.USERDEFINED.") && out.contains("'P',$,$,"), "{out}");
    assert_eq!(n, 1);
    assert!(warnings.iter().any(|w| w.contains("USERDEFINED rule") && w.contains("IFCWORKPLAN")), "{warnings:?}");
    let labelled = line.replace("'P',$,$,", "'P',$,'Custom',");
    assert_eq!(refused(&labelled, "IFC2X3", "IFC4").1, 0, "ObjectType set");
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
