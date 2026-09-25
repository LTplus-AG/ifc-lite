// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A native merge keeps a GlobalId-unified entity in one relationship per
//! single-valued inverse (#5774): in IFC2X3 a property set has one
//! `IfcRelDefinesByProperties` (`PropertyDefinitionOf : SET [0:1]`). The
//! TypeScript twin is `merged-inverse-claims.merge.test.ts`. Driven through the
//! public merge entry point, so the checks hold whatever the claim pass looks like.

use ifc_lite_export::{export_merged_with_stats, MergedOptions};

fn guid(label: &str) -> String {
    format!("{label:0<22}")
}

fn model(schema: &str, lines: &[String]) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        lines.join("\n")
    )
}

/// A project, proxies `objects` (ids from 10), and one property set (GlobalId
/// `pset`) defined on all of them by rel `rel` of type `rel_type`. `eq` is how
/// the rel line spells its `=`.
fn defined(schema: &str, project: &str, objects: &[&str], rel: &str, rel_type: &str, eq: &str) -> String {
    let mut lines = vec![format!("#1=IFCPROJECT('{}',$,'P',$,$,$,$,$,$);", guid(project))];
    let refs: Vec<String> = (0..objects.len()).map(|i| format!("#{}", 10 + i)).collect();
    for (i, tag) in objects.iter().enumerate() {
        lines.push(format!("#{}=IFCBUILDINGELEMENTPROXY('{}',$,'{tag}',$,$,$,$,$,$);", 10 + i, guid(tag)));
    }
    lines.push("#2=IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('R'),$);".to_string());
    lines.push(format!("#3=IFCPROPERTYSET('{}',$,'Pset_Test',$,(#2));", guid("pset")));
    let tail = if rel_type == "IFCRELOVERRIDESPROPERTIES" { ",(#2)" } else { "" };
    lines.push(format!("#4{eq}{rel_type}('{}',$,$,$,({}),#3{tail});", guid(rel), refs.join(",")));
    model(schema, &lines)
}

fn merge(schema: &str, models: &[String]) -> (String, Vec<String>) {
    let bytes: Vec<&[u8]> = models.iter().map(|m| m.as_bytes()).collect();
    let opts = MergedOptions { schema: Some(schema.to_string()), ..Default::default() };
    let (out, stats) = export_merged_with_stats(&bytes, &opts);
    (out, stats.warnings)
}

fn id_of(out: &str, label: &str) -> u32 {
    let needle = format!("('{}'", guid(label));
    let line = out.lines().find(|l| l.contains(&needle)).unwrap_or_else(|| panic!("{label} is in the output:\n{out}"));
    line[1..line.find('=').unwrap()].trim().parse().unwrap()
}

/// Every written definer of the property set, as the ids on its RelatedObjects list.
fn definers_of_pset(out: &str) -> Vec<Vec<u32>> {
    let pset = format!("#{}", id_of(out, "pset"));
    out.lines()
        .filter(|l| l.contains("IFCRELDEFINESBYPROPERTIES(") || l.contains("IFCRELOVERRIDESPROPERTIES("))
        .filter(|l| l.split(',').any(|arg| arg.trim_end_matches([')', ';']) == pset))
        .map(|l| {
            let list = &l[l.find(",(").unwrap() + 2..];
            list[..list.find(')').unwrap()].split(',').map(|r| r.trim_start_matches('#').parse().unwrap()).collect()
        })
        .collect()
}

#[test]
fn ifc2x3_folds_a_later_definer_of_a_unified_property_set_into_the_first() {
    let (out, warnings) = merge("IFC2X3", &[
        defined("IFC2X3", "pa", &["wall"], "ra", "IFCRELDEFINESBYPROPERTIES", "="),
        defined("IFC2X3", "pb", &["wall", "door"], "rb", "IFCRELDEFINESBYPROPERTIES", "="),
        defined("IFC2X3", "pc", &["door", "slab"], "rc", "IFCRELDEFINESBYPROPERTIES", "="),
    ]);
    let objects: Vec<u32> = ["wall", "door", "slab"].iter().map(|t| id_of(&out, t)).collect();
    assert_eq!(definers_of_pset(&out), vec![objects], "{out}");
    assert!(!out.contains(&guid("rb")) && !out.contains(&guid("rc")));
    assert!(warnings.iter().all(|w| !w.contains("lost that relationship")), "{warnings:?}");
}

/// STEP allows whitespace around `=`: the fold still finds its owner line.
#[test]
fn ifc2x3_folds_into_an_owner_line_that_spaces_its_equals_sign() {
    let (out, _) = merge("IFC2X3", &[
        defined("IFC2X3", "pa", &["wall"], "ra", "IFCRELDEFINESBYPROPERTIES", " = "),
        defined("IFC2X3", "pb", &["wall", "door"], "rb", "IFCRELDEFINESBYPROPERTIES", " = "),
    ]);
    assert_eq!(definers_of_pset(&out), vec![vec![id_of(&out, "wall"), id_of(&out, "door")]], "{out}");
}

/// IFC4 relaxes the property-set side to `DefinesOccurrence : SET [0:?]`.
#[test]
fn ifc4_keeps_both_definers() {
    let (out, _) = merge("IFC4", &[
        defined("IFC4", "pa", &["wall"], "ra", "IFCRELDEFINESBYPROPERTIES", "="),
        defined("IFC4", "pb", &["wall", "door"], "rb", "IFCRELDEFINESBYPROPERTIES", "="),
    ]);
    assert_eq!(definers_of_pset(&out).len(), 2, "{out}");
}

/// `IfcRelOverridesProperties.WR1` allows one object, so nothing folds into
/// one, and nothing folds across rel types: the later rel is withheld and the
/// object that lost the relationship is reported.
#[test]
fn ifc2x3_never_folds_into_an_override_or_across_rel_types() {
    for owner in ["IFCRELOVERRIDESPROPERTIES", "IFCRELDEFINESBYPROPERTIES"] {
        let (out, warnings) = merge("IFC2X3", &[
            defined("IFC2X3", "pa", &["wall"], "ra", owner, "="),
            defined("IFC2X3", "pb", &["door"], "rb", "IFCRELOVERRIDESPROPERTIES", "="),
        ]);
        assert_eq!(definers_of_pset(&out), vec![vec![id_of(&out, "wall")]], "{owner}:\n{out}");
        assert_eq!(warnings.iter().filter(|w| w.contains("lost that relationship")).count(), 1, "{owner}: {warnings:?}");
    }
}

/// How many written `rel_type` lines name `id` in argument `claimed`.
fn naming(out: &str, rel_type: &str, claimed: usize, id: u32) -> usize {
    let target = format!("#{id}");
    out.lines()
        .filter(|l| l.contains(&format!("={rel_type}(")))
        .filter(|l| {
            let args = &l[l.find('(').unwrap() + 1..l.rfind(')').unwrap()];
            let mut depth = 0;
            let mut slots = vec![String::new()];
            for c in args.chars() {
                match c {
                    '(' => depth += 1,
                    ')' => depth -= 1,
                    ',' if depth == 0 => {
                        slots.push(String::new());
                        continue;
                    }
                    _ => {}
                }
                slots.last_mut().unwrap().push(c);
            }
            slots[claimed].trim_matches(['(', ')']).split(',').any(|r| r.trim() == target)
        })
        .count()
}

/// #5923: each model states `rel` (`{a}` = the shared entity #10, `{b}` = its own
/// partner #11) about an entity both share by GlobalId. The merged file names
/// the shared entity on the claimed side (argument `claimed`) once.
fn one_rel_for_the_shared_entity(schema: &str, file_schema: &str, rel_type: &str, rel: &str, claimed: usize) {
    let model_of = |tag: &str| {
        model(file_schema, &[
            format!("#1=IFCPROJECT('{}',$,'P',$,$,$,$,$,$);", guid(&format!("p{tag}"))),
            format!("#10=IFCBUILDINGELEMENTPROXY('{}',$,'shared',$,$,$,$,$,$);", guid("shared")),
            format!("#11=IFCBUILDINGELEMENTPROXY('{}',$,'own',$,$,$,$,$,$);", guid(&format!("own{tag}"))),
            format!("#20={rel_type}('{}',$,$,$,{});", guid(&format!("r{tag}")), rel),
        ])
    };
    let (out, _) = merge(schema, &[model_of("a"), model_of("b")]);
    assert_eq!(naming(&out, rel_type, claimed, id_of(&out, "shared")), 1, "{schema} {rel_type}:\n{out}");
}

#[test]
fn a_shared_element_keeps_one_containment_void_fill_and_type() {
    for (schema, file_schema) in [("IFC2X3", "IFC2X3"), ("IFC4", "IFC4"), ("IFC4X3", "IFC4X3_ADD2")] {
        one_rel_for_the_shared_entity(schema, file_schema, "IFCRELCONTAINEDINSPATIALSTRUCTURE", "(#10),#11", 4);
        one_rel_for_the_shared_entity(schema, file_schema, "IFCRELVOIDSELEMENT", "#11,#10", 5);
        one_rel_for_the_shared_entity(schema, file_schema, "IFCRELFILLSELEMENT", "#11,#10", 5);
        // The object side: IFC2X3 IfcObject.WR1, IFC4 IsTypedBy.
        one_rel_for_the_shared_entity(schema, file_schema, "IFCRELDEFINESBYTYPE", "(#10),#11", 4);
        // The type side: IFC2X3 ObjectTypeOf, IFC4 Types (the later object is folded in).
        one_rel_for_the_shared_entity(schema, file_schema, "IFCRELDEFINESBYTYPE", "(#11),#10", 5);
    }
    one_rel_for_the_shared_entity("IFC4X3", "IFC4X3_ADD2", "IFCRELADHERESTOELEMENT", "#11,(#10)", 5);
    one_rel_for_the_shared_entity("IFC4", "IFC4", "IFCRELDECLARES", "#11,(#10)", 5);
}

/// A type's later objects join the type's first `IfcRelDefinesByType`, so no
/// object loses its type (#5923).
#[test]
fn a_later_model_s_new_object_joins_the_shared_type_s_first_rel() {
    for (schema, file_schema) in [("IFC2X3", "IFC2X3"), ("IFC4", "IFC4")] {
        let model_of = |tag: &str, objects: &[&str]| {
            let mut lines = vec![
                format!("#1=IFCPROJECT('{}',$,'P',$,$,$,$,$,$);", guid(&format!("p{tag}"))),
                format!("#5=IFCBUILDINGELEMENTPROXYTYPE('{}',$,'T',$,$,$,$,$,$,.NOTDEFINED.);", guid("type")),
            ];
            let refs: Vec<String> = objects.iter().enumerate().map(|(i, o)| {
                lines.push(format!("#{}=IFCBUILDINGELEMENTPROXY('{}',$,'{o}',$,$,$,$,$,$);", 10 + i, guid(o)));
                format!("#{}", 10 + i)
            }).collect();
            lines.push(format!("#20=IFCRELDEFINESBYTYPE('{}',$,$,$,({}),#5);", guid(&format!("r{tag}")), refs.join(",")));
            model(file_schema, &lines)
        };
        let (out, _) = merge(schema, &[model_of("a", &["wall"]), model_of("b", &["wall", "door"])]);
        let (wall, door) = (id_of(&out, "wall"), id_of(&out, "door"));
        assert_eq!(naming(&out, "IFCRELDEFINESBYTYPE", 5, id_of(&out, "type")), 1, "{schema}:\n{out}");
        assert_eq!(naming(&out, "IFCRELDEFINESBYTYPE", 4, wall), 1, "{schema}");
        assert_eq!(naming(&out, "IFCRELDEFINESBYTYPE", 4, door), 1, "{schema}: the door keeps its type");
    }
}
