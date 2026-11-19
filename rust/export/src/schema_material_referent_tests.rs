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
    let mut scanned = super::MaterialReferents::scan(src.as_bytes(), "IFC4X3", "IFC2X3", &|_, _| true);
    assert_eq!(scanned.apply(5, "#5=IFCEXTENDEDMATERIALPROPERTIES(#21,(#6),$,'Pset_x');".into(), &mut 0), "#5=IFCEXTENDEDMATERIALPROPERTIES(#9,(#6),$,'Pset_x');");
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

/// From /code-review: the record is checked as the export writes it, so an
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

/// From /code-review: on the log path a created record is resolved as
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

/// From /code-review: a copy-on-write copy is a material record as written.
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
