// SPDX-License-Identifier: MPL-2.0
use crate::step::{export_step_with_diagnostics, StepOptions};
use crate::step_api::AttrMutation;

fn model(schema: &str, data: &str) -> String {
    format!("ISO-10303-21;HEADER;FILE_SCHEMA(('{schema}'));ENDSEC;DATA;\n{data}\nENDSEC;END-ISO-10303-21;")
}
fn record(out: &str, id: &str) -> String { out.lines().find(|l| l.starts_with(id)).unwrap_or_default().to_string() }

/// The IFC2X3 output's material-properties record, the values counted dropped, and the warnings.
fn down(from: &str, data: &str) -> (String, usize, Vec<String>) {
    let data = format!("#8=IFCMATERIAL('Concrete',$,$);\n#9=IFCMATERIAL('Steel',$,$);\n#6=IFCPROPERTYSINGLEVALUE('p',$,IFCLABEL('v'),$);\n{data}");
    let options = StepOptions { schema: Some("IFC2X3".into()), ..StepOptions::default() };
    let (out, stats, warnings) = export_step_with_diagnostics(model(from, &data).as_bytes(), &options).unwrap();
    (record(&out, "#5="), stats.attribute_values_dropped, warnings)
}

/// CodeRabbit on #10781: IFC4 lets Material name any IfcMaterialDefinition;
/// IFC2X3 takes an IfcMaterial. A material is carried as it is.
#[test]
fn a_material_is_carried_10763() {
    for from in ["IFC4", "IFC4X3"] {
        let (out, dropped, _) = down(from, "#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6),#8);");
        assert_eq!((out.as_str(), dropped), ("#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),'d','Pset_x');", 0), "{from}");
    }
}

/// A layer, or a set whose members name one material (an air gap names
/// none), is pointed at that material.
#[test]
fn a_definition_of_one_material_names_that_material_10763() {
    let layers = "#10=IFCMATERIALLAYER(#8,0.2,$,$,$,$,$);\n#11=IFCMATERIALLAYER($,0.05,.T.,$,$,$,$);\n#12=IFCMATERIALLAYER(#8,0.1,$,$,$,$,$);\n";
    let (out, dropped, _) = down("IFC4", &format!("{layers}#13=IFCMATERIALLAYERSET((#10,#11,#12),'Wall',$);\n#5=IFCMATERIALPROPERTIES('Pset_x',$,(#6),#13);"));
    assert_eq!((out.as_str(), dropped), ("#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),$,'Pset_x');", 0));
    let (out, _, _) = down("IFC4", &format!("{layers}#5=IFCMATERIALPROPERTIES('Pset_x',$,(#6),#10);"));
    assert_eq!(out, "#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),$,'Pset_x');");
    // IFC2X3 has no constituent set, so an export holding one is refused before
    // this runs; the scan still resolves it.
    let src = model("IFC4X3", "#9=IFCMATERIAL('Steel',$,$);\n#20=IFCMATERIALCONSTITUENT('c',$,#9,0.5,$);\n#21=IFCMATERIALCONSTITUENTSET('s',$,(#20));\n#5=IFCMATERIALPROPERTIES('Pset_x',$,(#6),#21);");
    let mut scanned = super::MaterialReferents::scan(src.as_bytes(), "IFC4X3", "IFC2X3", false, &|_, _| true);
    assert_eq!(scanned.apply(5, "#5=IFCMATERIALPROPERTIES('Pset_x',$,(#6),#21);", "IFC4X3", &mut 0).as_deref(), Some("#5=IFCMATERIALPROPERTIES('Pset_x',$,(#6),#9);"));
}

/// A set of two materials names no single one: the record is not written,
/// its values are counted, and the export names it.
#[test]
fn a_definition_of_two_materials_is_not_written_and_named_10763() {
    let data = "#10=IFCMATERIALLAYER(#8,0.2,$,$,$,$,$);\n#12=IFCMATERIALLAYER(#9,0.1,$,$,$,$,$);\n#13=IFCMATERIALLAYERSET((#10,#12),'Wall',$);\n#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6),#13);";
    let (out, dropped, warnings) = down("IFC4", data);
    assert_eq!((out.as_str(), dropped), ("", 4));
    assert!(warnings.iter().any(|w| w.starts_with("1 IfcMaterialProperties record(s) were not written") && w.contains("#5 (IFCMATERIALLAYERSET)")), "{warnings:?}");
}

/// The record is checked as the export writes it, so an
/// edit of `Material` is resolved as edited, and a record the export leaves
/// out anyway is not reported.
#[test]
fn the_written_record_is_what_is_checked_10763() {
    let data = "#8=IFCMATERIAL('Concrete',$,$);\n#9=IFCMATERIAL('Steel',$,$);\n#6=IFCPROPERTYSINGLEVALUE('p',$,IFCLABEL('v'),$);\n#10=IFCMATERIALLAYER(#8,0.2,$,$,$,$,$);\n#12=IFCMATERIALLAYER(#9,0.1,$,$,$,$,$);\n#13=IFCMATERIALLAYERSET((#10,#12),'Wall',$);\n#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6),#13);";
    let src = model("IFC4", data);
    let edited = StepOptions {
        schema: Some("IFC2X3".into()),
        attribute_mutations: vec![AttrMutation { express_id: 5, index: 3, value: "#8".into() }],
        ..StepOptions::default()
    };
    let (out, _, warnings) = export_step_with_diagnostics(src.as_bytes(), &edited).unwrap();
    assert_eq!(record(&out, "#5="), "#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),'d','Pset_x');");
    assert!(!warnings.iter().any(|w| w.contains("IfcMaterialProperties record(s)")), "{warnings:?}");
    // The layer edited to the other layer's material: the set now holds one.
    let layer = StepOptions { schema: Some("IFC2X3".into()), attribute_mutations: vec![AttrMutation { express_id: 12, index: 0, value: "#8".into() }], ..StepOptions::default() };
    assert_eq!(record(&export_step_with_diagnostics(src.as_bytes(), &layer).unwrap().0, "#5="), "#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),'d','Pset_x');");
    let subset = StepOptions { schema: Some("IFC2X3".into()), included: Some(vec![6, 8, 9, 10, 12, 13]), ..StepOptions::default() };
    // A subset pulls in what its records reference, so the material named is written too.
    let unwritten = StepOptions { schema: Some("IFC2X3".into()), included: Some(vec![5, 6, 9, 10, 13]), ..StepOptions::default() };
    let (out, _, _) = export_step_with_diagnostics(model("IFC4", "#8=IFCMATERIAL('Concrete',$,$);\n#6=IFCPROPERTYSINGLEVALUE('p',$,IFCLABEL('v'),$);\n#10=IFCMATERIALLAYER(#8,0.2,$,$,$,$,$);\n#13=IFCMATERIALLAYERSET((#10),'Wall',$);\n#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6),#13);").as_bytes(), &unwritten).unwrap();
    assert_eq!(record(&out, "#5="), "#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),'d','Pset_x');");
    assert_eq!(record(&out, "#8="), "#8=IFCMATERIAL('Concrete');");
    let (_, stats, warnings) = export_step_with_diagnostics(src.as_bytes(), &subset).unwrap();
    assert!(!warnings.iter().any(|w| w.contains("IfcMaterialProperties record(s)")), "{warnings:?}");
    assert_eq!(stats.attribute_values_dropped, 0);
}

/// On the log path a created record is resolved as
/// written, against source and created materials alike, even when the source
/// holds no IfcMaterialProperties.
#[test]
fn a_log_created_record_is_resolved_10763() {
    let src = model("IFC4", "#8=IFCMATERIAL('Concrete',$,$);\n#6=IFCPROPERTYSINGLEVALUE('p',$,IFCLABEL('v'),$);");
    let log = crate::MutationLog::from_json(
        r##"{"mutations":[{"type":"CREATE_ENTITY","entityId":50,"attributeName":"IfcMaterialProperties"},
                         {"type":"CREATE_ENTITY","entityId":60,"attributeName":"IfcMaterial"},
                         {"type":"CREATE_ENTITY","entityId":51,"attributeName":"IfcMaterialProperties"}],
            "newEntities":[{"expressId":50,"type":"IfcMaterialProperties","attributes":["P",null,["#6"],"#8"]},
                           {"expressId":60,"type":"IfcMaterial","attributes":["New",null,null]},
                           {"expressId":51,"type":"IfcMaterialProperties","attributes":["Q",null,["#6"],"#60"]}]}"##,
    )
    .unwrap();
    let opts = StepOptions { schema: Some("IFC2X3".into()), ..StepOptions::default() };
    let (out, _) = crate::export_step_with_log(src.as_bytes(), &opts, &log).unwrap();
    assert_eq!(record(&out, "#50="), "#50=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),$,'P');", "{out}");
    assert_eq!(record(&out, "#51="), "#51=IFCEXTENDEDMATERIALPROPERTIES(#60,(#6),$,'Q');", "{out}");
}

/// A copy-on-write copy is a material record as written.
/// Layer #10 copied with Steel and set #13 pointed at the copy: the set now
/// names two materials, so #5 is not written (it read Concrete alone before).
#[test]
fn a_copy_on_write_copy_is_resolved_as_written_10763() {
    let src = model("IFC4", "#8=IFCMATERIAL('Concrete',$,$);\n#9=IFCMATERIAL('Steel',$,$);\n#6=IFCPROPERTYSINGLEVALUE('p',$,IFCLABEL('v'),$);\n#10=IFCMATERIALLAYER(#8,0.2,$,$,$,$,$);\n#12=IFCMATERIALLAYER(#8,0.1,$,$,$,$,$);\n#13=IFCMATERIALLAYERSET((#10,#12),'Wall',$);\n#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6),#13);");
    let opts = StepOptions {
        schema: Some("IFC2X3".into()),
        copy_on_write: vec![crate::step_api::CopyOnWriteMutation { express_id: 10, index: 0, value: "#9".into(), referrer_id: 13, referrer_index: 0 }],
        ..StepOptions::default()
    };
    let (out, _, warnings) = export_step_with_diagnostics(src.as_bytes(), &opts).unwrap();
    assert_eq!(record(&out, "#5="), "", "{out}");
    assert!(warnings.iter().any(|w| w.contains("#5 (IFCMATERIALLAYERSET)")), "{warnings:?}");
}

fn log_export(src: &str, log: &str) -> (String, Vec<String>) {
    let log = crate::MutationLog::from_json(log).unwrap();
    let opts = StepOptions { schema: Some("IFC2X3".into()), ..StepOptions::default() };
    let (out, stats) = crate::export_step_with_log(src.as_bytes(), &opts, &log).unwrap();
    (out, stats.warnings)
}

const LAYERED: &str = "#8=IFCMATERIAL('Concrete',$,$);\n#9=IFCMATERIAL('Steel',$,$);\n#6=IFCPROPERTYSINGLEVALUE('p',$,IFCLABEL('v'),$);\n#10=IFCMATERIALLAYER(#8,0.2,$,$,$,$,$);\n#12=IFCMATERIALLAYER(#9,0.1,$,$,$,$,$);\n#13=IFCMATERIALLAYERSET((#10,#12),'Wall',$);\n#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6),#13);";

/// Hosted CodeRabbit on #10781: the referents are the records the export
/// writes. An overlay-created layer is read as written.
#[test]
fn an_overlay_created_layer_resolves_as_written_10763() {
    let (out, _) = log_export(&model("IFC4", "#8=IFCMATERIAL('Concrete',$,$);\n#6=IFCPROPERTYSINGLEVALUE('p',$,IFCLABEL('v'),$);"), r##"{"mutations":[{"type":"CREATE_ENTITY","entityId":61,"attributeName":"IfcMaterialLayer"},{"type":"CREATE_ENTITY","entityId":51,"attributeName":"IfcMaterialProperties"}],
        "newEntities":[{"expressId":61,"type":"IfcMaterialLayer","attributes":["#8",0.2,null,null,null,null,null]},
                       {"expressId":51,"type":"IfcMaterialProperties","attributes":["Q",null,["#6"],"#61"]}]}"##);
    assert_eq!(record(&out, "#51="), "#51=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),$,'Q');", "{out}");
}

/// A material retyped away is no longer one to name.
#[test]
fn a_retyped_material_is_not_named_10763() {
    let src = model("IFC4", "#8=IFCMATERIAL('Concrete',$,$);\n#6=IFCPROPERTYSINGLEVALUE('p',$,IFCLABEL('v'),$);\n#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6),#8);");
    let (out, warnings) = log_export(&src, r#"{"mutations":[{"type":"UPDATE_ENTITY_TYPE","entityId":8,"entityType":"IfcMaterialLayer"}]}"#);
    assert_eq!(record(&out, "#5="), "", "{out}");
    assert!(warnings.iter().any(|w| w.contains("#5 (")), "{warnings:?}");
}

/// A deleted layer is left out of its set, as the writer leaves it out of the
/// list, so the surviving layer's material is the one named.
#[test]
fn a_deleted_layer_leaves_its_set_one_material_10763() {
    let (out, warnings) = log_export(&model("IFC4", LAYERED), r#"{"mutations":[{"type":"DELETE_ENTITY","entityId":12}]}"#);
    assert_eq!(record(&out, "#13="), "#13=IFCMATERIALLAYERSET((#10),'Wall');", "{out}");
    assert_eq!(record(&out, "#5="), "#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),'d','Pset_x');", "{out}");
    assert!(!warnings.iter().any(|w| w.contains("IfcMaterialProperties record(s)")), "{warnings:?}");
}

/// #11243: a created layer deleted again has no source record, only a
/// tombstone, and the writer leaves it out of the list, so the set resolves
/// through the surviving layer. Twin of the TypeScript case.
#[test]
fn a_created_then_deleted_layer_leaves_its_set_one_material_11243() {
    // The log `MutablePropertyView.exportMutations` writes: deleting a created
    // entity purges its CREATE_ENTITY, so only the tombstone and the set edit remain.
    let (out, warnings) = log_export(&model("IFC4", LAYERED), r##"{"mutations":[
        {"type":"UPDATE_POSITIONAL_ATTRIBUTE","entityId":13,"attributeName":"@0","newValue":["#10","#61"]},
        {"type":"DELETE_ENTITY","entityId":61}]}"##);
    assert_eq!(record(&out, "#13="), "#13=IFCMATERIALLAYERSET((#10),'Wall');", "{out}");
    assert_eq!(record(&out, "#5="), "#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),'d','Pset_x');", "{out}");
    assert!(!warnings.iter().any(|w| w.contains("IfcMaterialProperties record(s)")), "{warnings:?}");
}

/// A set member the export still writes
/// but no longer as a layer (retyped away), or one no record has, names no
/// material, so the set names no single one and the record is left out; only
/// a member the export does not write is skipped. Twin of the TypeScript case.
#[test]
fn a_member_written_as_another_type_or_missing_names_no_material_10763() {
    let (out, warnings) = log_export(&model("IFC4", LAYERED), r#"{"mutations":[{"type":"UPDATE_ENTITY_TYPE","entityId":12,"entityType":"IfcPropertySingleValue"}]}"#);
    assert_eq!(record(&out, "#5="), "", "{out}");
    assert!(warnings.iter().any(|w| w.contains("#5 (IFCMATERIALLAYERSET)")), "{warnings:?}");
    let dangling = LAYERED.replace("((#10,#12),'Wall',$)", "((#10,#99),'Wall',$)");
    assert!(dangling.contains("((#10,#99)"), "the set names #10 (one material) and a missing #99");
    let (out, _) = log_export(&model("IFC4", &dangling), r#"{"mutations":[]}"#);
    assert_eq!(record(&out, "#5="), "", "{out}");
}

/// The merged writer resolves each model's referents in the merge's id space.
#[test]
fn the_merged_writer_resolves_each_models_referents_10763() {
    let one = model("IFC4", "#8=IFCMATERIAL('Concrete',$,$);\n#6=IFCPROPERTYSINGLEVALUE('p',$,IFCLABEL('v'),$);\n#10=IFCMATERIALLAYER(#8,0.2,$,$,$,$,$);\n#13=IFCMATERIALLAYERSET((#10),'Wall',$);\n#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6),#13);");
    let two = model("IFC4", LAYERED);
    let models = [crate::MergedModel::new(one.as_bytes()), crate::MergedModel::new(two.as_bytes())];
    let (out, stats) = crate::export_merged_models(&models, &crate::MergedOptions { schema: Some("IFC2X3".into()), ..crate::MergedOptions::default() });
    let materials: Vec<&str> = out.lines().filter(|l| l.contains("=IFCEXTENDEDMATERIALPROPERTIES(")).collect();
    // The first model's set names one material; the second's names two, so its record is not written.
    assert_eq!(materials, ["#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),'d','Pset_x');"], "{out}");
    assert!(!out.contains("IFCMATERIALPROPERTIES("), "{out}");
    assert!(stats.warnings.iter().any(|w| w.starts_with("1 IfcMaterialProperties record(s) were not written")), "{:?}", stats.warnings);
}

#[test]
fn a_filtered_layer_does_not_hide_a_later_models_written_layer_10911() {
    let one_layer = LAYERED.replace("(#10,#12)", "(#10)");
    let first = model("IFC4", &format!("{one_layer}\n#23=IFCMATERIALLAYER(#8,0.3,$,$,$,$,$);"));
    let second = model("IFC4", LAYERED);
    let models = [
        crate::MergedModel { included: Some(vec![5]), ..crate::MergedModel::new(first.as_bytes()) },
        crate::MergedModel::new(second.as_bytes()),
    ];
    let opts = crate::MergedOptions { schema: Some("IFC2X3".into()), ..Default::default() };
    let (out, stats) = crate::export_merged_models(&models, &opts);
    assert_eq!(record(&out, "#5="), "#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),'d','Pset_x');");
    assert!(record(&out, "#23=").starts_with("#23=IFCMATERIALLAYER(#21,"), "{out}");
    assert_eq!(record(&out, "#18="), "", "{out}");
    assert!(stats.warnings.iter().any(|w| w.contains("#18 (IFCMATERIALLAYERSET)")), "{:?}", stats.warnings);
}

#[test]
fn the_merged_writer_resolves_only_the_last_material_occurrence_10911() {
    let source = model("IFC4", "#8=IFCMATERIAL('Concrete',$,$);\n#8=IFCPROPERTYSINGLEVALUE('Wrong type',$,IFCLABEL('v'),$);\n#9=IFCMATERIAL('Steel',$,$);\n#6=IFCPROPERTYSINGLEVALUE('p',$,IFCLABEL('v'),$);\n#5=IFCMATERIALPROPERTIES('P',$,(#6),#8);
#10=IFCMATERIALLAYER(#9,0.2,$,$,$,$,$);
#10=IFCPROPERTYSINGLEVALUE('Wrong member',$,IFCLABEL('v'),$);
#12=IFCMATERIALLAYER(#9,0.2,$,$,$,$,$);
#13=IFCMATERIALLAYERSET((#10,#12),'Wall',$);
#14=IFCMATERIALPROPERTIES('Set',$,(#6),#13);
#15=IFCMATERIALPROPERTIES('Valid',$,(#6),#9);");
    let (out, stats) = crate::export_merged_models(&[crate::MergedModel::new(source.as_bytes())], &crate::MergedOptions { schema: Some("IFC2X3".into()), ..Default::default() });
    assert!(record(&out, "#8=").starts_with("#8=IFCPROPERTYSINGLEVALUE("), "{out}");
    assert_eq!(record(&out, "#5="), "", "{out}");
    assert_eq!(record(&out, "#14="), "", "{out}");
    assert_eq!(record(&out, "#15="), "#15=IFCEXTENDEDMATERIALPROPERTIES(#9,(#6),$,'Valid');");
    assert!(stats.warnings.iter().any(|w| w.contains("#5 (an unread record)")), "{:?}", stats.warnings);
}

#[test]
fn unreadable_direct_and_layer_materials_leave_out_properties_10911() {
    let source = model("IFC4", "#8=IFCMATERIAL('Steel',$,$);\n#10=IFCMATERIALLAYER(#8,0.2,$,$,$,$,$);");
    let mut materials = super::MaterialReferents::scan(source.as_bytes(), "IFC4", "IFC2X3", true, &|_, _| true);
    materials.with_effective("IFC4", &|_| true, [(8, "#8=IFCMATERIAL('Steel',$,$;")]);
    for referent in [8, 10] {
        let line = format!("#5=IFCMATERIALPROPERTIES('P',$,(#6),#{referent});");
        assert_eq!(materials.apply(5, &line, "IFC4", &mut 0), None, "{line}");
    }
}

#[test]
fn omitted_duplicate_material_properties_are_counted_once_10911() {
    let (out, dropped, warnings) = down("IFC4",
        "#5=IFCMATERIALPROPERTIES('Earlier',$,(#6),#8);\n#5=IFCMATERIALPROPERTIES('Kept',$,(#6),#99);");
    assert!(out.is_empty(), "{out}");
    assert_eq!(dropped, 3);
    assert!(warnings.iter().any(|warn| warn == "1 IfcMaterialProperties record(s) were not written: IFC2X3 IfcExtendedMaterialProperties.Material must name one IfcMaterial, and theirs does not: #5 (an unread record) (#10763)."), "{warnings:?}");
}

#[test]
fn a_material_edited_into_a_withheld_relationship_is_not_named_10911() {
    let source = model("IFC4", "#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);\n#5=IFCMATERIALPROPERTIES('Pset_x',$,(#6),#8);\n#6=IFCPROPERTYSINGLEVALUE('p',$,IFCLABEL('v'),$);\n#8=IFCMATERIAL('Concrete',$,$);\n#9=IFCMATERIAL('Steel',$,$);");
    let log = r##"{"mutations":[{"type":"UPDATE_ENTITY_TYPE","entityId":8,"entityType":"IfcRelAggregates"},{"type":"UPDATE_POSITIONAL_ATTRIBUTE","entityId":8,"attributeName":"@4","newValue":"#9"},{"type":"UPDATE_POSITIONAL_ATTRIBUTE","entityId":8,"attributeName":"@5","newValue":"(#1)"},{"type":"DELETE_ENTITY","entityId":9}]}"##;
    let (out, warnings) = log_export(&source, log);
    assert!(record(&out, "#8=").is_empty(), "{out}");
    assert!(record(&out, "#5=").is_empty(), "{out}");
    assert!(warnings.iter().any(|warn| warn.contains("#5 (an unread record)")), "{warnings:?}");
}

/// From CodeRabbit on #10911: a record without its ';' is checked like one
/// with it, and a duplicate id left out does not hide the occurrence kept.
#[test]
fn a_bare_record_is_checked_and_a_kept_duplicate_counts_10763() {
    let src = model("IFC4", "#8=IFCMATERIAL('Concrete',$,$);\n#9=IFCMATERIAL('Steel',$,$);\n#10=IFCMATERIALLAYER(#8,0.2,$,$,$,$,$);\n#12=IFCMATERIALLAYER(#9,0.1,$,$,$,$,$);\n#13=IFCMATERIALLAYERSET((#10,#12),'Wall',$);\n#14=IFCMATERIALLAYERSET((#10),'One',$);");
    let mut scanned = super::MaterialReferents::scan(src.as_bytes(), "IFC4", "IFC2X3", true, &|_, _| true);
    assert_eq!(scanned.apply(5, "#5=IFCMATERIALPROPERTIES('P',$,(#6),#13)", "IFC4", &mut 0), None);
    assert_eq!(scanned.apply(5, "#5=IFCMATERIALPROPERTIES('P',$,(#6),#14)", "IFC4", &mut 0).as_deref(), Some("#5=IFCMATERIALPROPERTIES('P',$,(#6),#8)"));
    // The second #10 is the one `kept` refuses; the first stays a Concrete layer.
    let dup = model("IFC4", "#8=IFCMATERIAL('Concrete',$,$);\n#9=IFCMATERIAL('Steel',$,$);\n#10=IFCMATERIALLAYER(#8,0.2,$,$,$,$,$);\n#10=IFCMATERIALLAYER(#9,0.2,$,$,$,$,$);\n#12=IFCMATERIALLAYER(#9,0.1,$,$,$,$,$);\n#13=IFCMATERIALLAYERSET((#10,#12),'Wall',$);");
    let second = dup.match_indices("#10=").nth(1).unwrap().0;
    let mut scanned = super::MaterialReferents::scan(dup.as_bytes(), "IFC4", "IFC2X3", true, &|id, start| id != 10 || start < second);
    assert_eq!(scanned.apply(5, "#5=IFCMATERIALPROPERTIES('P',$,(#6),#13);", "IFC4", &mut 0), None, "two materials: left out");
}

/// A record whose slots cannot be read is left
/// out and named, not written unchecked.
#[test]
fn an_unreadable_record_is_left_out_10763() {
    let src = model("IFC4", "#8=IFCMATERIAL('Concrete',$,$);");
    let mut scanned = super::MaterialReferents::scan(src.as_bytes(), "IFC4", "IFC2X3", true, &|_, _| true);
    assert_eq!(scanned.apply(5, "#5=IFCMATERIALPROPERTIES('P',$,(#6),#8);", "IFC4", &mut 0).as_deref(), Some("#5=IFCMATERIALPROPERTIES('P',$,(#6),#8);"));
    let commented = "#5=IFCMATERIALPROPERTIES('P',$,(#6),#8);/* c */";
    assert_eq!(scanned.apply(5, commented, "IFC4", &mut 0).as_deref(), Some(commented), "a comment after the ';' is no missing ';'");
    let mut lost = 0;
    assert_eq!(scanned.apply(7, "#7=IFCMATERIALPROPERTIES('P',$,(#6,#8);", "IFC4", &mut lost), None);
    assert_eq!(lost, 1, "an unread record counts");
    assert!(scanned.warnings().concat().contains("#7 (unreadable)"));
}
