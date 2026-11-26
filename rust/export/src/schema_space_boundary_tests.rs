// SPDX-License-Identifier: MPL-2.0
use crate::schema_convert::convert_step_line;
use crate::schema_ifc2x3_slots::Ifc2x3SlotFill;
use crate::step::{export_step_with_diagnostics, StepOptions};

const VIRTUAL: &str = "#20=IFCRELSPACEBOUNDARY('3XigBlHYfFnxzvgV9_gBmP',$,'1stLevel',$,#10,$,#12,.VIRTUAL.,.INTERNAL.);";
const PHYSICAL: &str = "#21=IFCRELSPACEBOUNDARY('1XigBlHYfFnxzvgV9_gBmP',$,'1stLevel',$,#10,#11,#12,.PHYSICAL.,.EXTERNAL.);";
const PHYSICAL_UNBOUND: &str = "#22=IFCRELSPACEBOUNDARY('2XigBlHYfFnxzvgV9_gBmP',$,'1stLevel',$,#10,$,$,.PHYSICAL.,.EXTERNAL.);";

fn data() -> String {
    format!("#10=IFCSPACE('0YvctVUKr0kugbFTf53O9L',$,'S',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);\n#11=IFCWALL('1YvctVUKr0kugbFTf53O9L',$,'W',$,$,$,$,$);\n#12=IFCCONNECTIONSURFACEGEOMETRY(#13,$);\n#13=IFCPLANE(#14);\n#14=IFCAXIS2PLACEMENT3D(#15,$,$);\n#15=IFCCARTESIANPOINT((0.,0.,0.));\n{VIRTUAL}\n{PHYSICAL}\n{PHYSICAL_UNBOUND}")
}
fn model(schema: &str, data: &str) -> String {
    format!("ISO-10303-21;HEADER;FILE_SCHEMA(('{schema}'));ENDSEC;DATA;\n{data}\nENDSEC;END-ISO-10303-21;")
}
fn convert(line: &str, from: &str, to: &str) -> String {
    convert_step_line(line, from, to, 1, &mut Ifc2x3SlotFill::new(None), None).unwrap()
}

/// Every upgrade target that requires the element leaves a boundary without one out; one naming an element stays.
#[test]
fn convert_step_line_omits_a_boundary_with_no_element() {
    for to in ["IFC4", "IFC4X3"] {
        assert_eq!(convert(VIRTUAL, "IFC2X3", to), "", "{to}");
        assert_eq!(convert(PHYSICAL_UNBOUND, "IFC2X3", to), "", "{to}");
        assert_eq!(convert(PHYSICAL, "IFC2X3", to), PHYSICAL, "{to}");
    }
}

/// An upgrade rule only: the other directions keep the record.
#[test]
fn the_other_directions_keep_it() {
    assert_eq!(convert(VIRTUAL, "IFC4", "IFC4X3"), VIRTUAL);
    assert_ne!(convert(VIRTUAL, "IFC4", "IFC2X3"), "");
}

/// The export writes the others, counts the values dropped and names the sites.
#[test]
fn the_export_names_what_it_left_out() {
    let options = StepOptions { schema: Some("IFC4".into()), ..StepOptions::default() };
    let (out, stats, warnings) = export_step_with_diagnostics(model("IFC2X3", &data()).as_bytes(), &options).unwrap();
    let kept: Vec<&str> = out.lines().filter(|l| l.contains("=IFCRELSPACEBOUNDARY(")).map(|l| &l[..l.find('=').unwrap()]).collect();
    assert_eq!(kept, ["#21"]);
    assert!(warnings.iter().any(|w| w.contains("2 IfcRelSpaceBoundary record(s) were not written: IFC4 requires RelatedBuildingElement and the source names none: #20, #22.")), "{warnings:?}");
    assert_eq!(stats.attribute_values_dropped, 11);
}

/// #11457: a relationship naming a left-out boundary has it removed from its list; one left with no member is
/// withheld and reported. Twin of the TypeScript test of the same name.
#[test]
fn a_relationship_naming_a_left_out_boundary_is_scrubbed() {
    let rels = "#31=IFCCLASSIFICATION('S','E',$,'N');\n#32=IFCRELASSOCIATESCLASSIFICATION('4XigBlHYfFnxzvgV9_gBmP',$,$,$,(#20,#11),#31);\n#33=IFCRELASSOCIATESCLASSIFICATION('5XigBlHYfFnxzvgV9_gBmP',$,$,$,(#20),#31);";
    let options = StepOptions { schema: Some("IFC4".into()), ..StepOptions::default() };
    let (out, _, warnings) = export_step_with_diagnostics(model("IFC2X3", &format!("{}\n{rels}", data())).as_bytes(), &options).unwrap();
    let kept: Vec<&str> = out.lines().filter(|l| l.contains("=IFCRELASSOCIATESCLASSIFICATION(")).collect();
    assert_eq!(kept, ["#32=IFCRELASSOCIATESCLASSIFICATION('4XigBlHYfFnxzvgV9_gBmP',$,$,$,(#11),#31);"], "{out}");
    assert!(!out.contains("#20"), "{out}");
    assert!(warnings.iter().any(|w| w.to_lowercase().contains("relationship #33 (ifcrelassociatesclassification) was withheld")), "{warnings:?}");
}

/// The same scrub through the mutation-log writer (#11457), with a log that edits nothing.
#[test]
fn the_log_writer_scrubs_the_same_way() {
    let rels = "#31=IFCCLASSIFICATION('S','E',$,'N');\n#32=IFCRELASSOCIATESCLASSIFICATION('4XigBlHYfFnxzvgV9_gBmP',$,$,$,(#20,#11),#31);\n#33=IFCRELASSOCIATESCLASSIFICATION('5XigBlHYfFnxzvgV9_gBmP',$,$,$,(#20),#31);";
    let options = StepOptions { schema: Some("IFC4".into()), ..StepOptions::default() };
    let log = crate::step_log::MutationLog::default();
    let (out, _) = crate::step_log::export_step_with_log(model("IFC2X3", &format!("{}\n{rels}", data())).as_bytes(), &options, &log).unwrap();
    let kept: Vec<&str> = out.lines().filter(|l| l.contains("=IFCRELASSOCIATESCLASSIFICATION(")).collect();
    assert_eq!(kept, ["#32=IFCRELASSOCIATESCLASSIFICATION('4XigBlHYfFnxzvgV9_gBmP',$,$,$,(#11),#31);"], "{out}");
    assert!(!out.contains("#20"), "{out}");
}

/// #11457: the merged writer scrubs a left-out boundary from its referrers in the merge id space, and omits a
/// relationship left with no member. Twin of the TypeScript merged test.
#[test]
fn the_merged_writer_scrubs_a_left_out_boundary() {
    let rels = "#31=IFCCLASSIFICATION('S','E',$,'N');\n#32=IFCRELASSOCIATESCLASSIFICATION('4XigBlHYfFnxzvgV9_gBmP',$,$,$,(#20,#11),#31);\n#33=IFCRELASSOCIATESCLASSIFICATION('5XigBlHYfFnxzvgV9_gBmP',$,$,$,(#20),#31);";
    let source = model("IFC2X3", &format!("{}\n{rels}", data()));
    let options = crate::merged::MergedOptions { schema: Some("IFC4".into()), ..Default::default() };
    let (out, stats) = crate::merged::export_merged_with_stats(&[source.as_bytes(), source.as_bytes()], &options);
    let body = &out[out.find("DATA;").unwrap()..];
    let defined: std::collections::HashSet<&str> = body.lines().filter_map(|l| l.strip_prefix('#')?.split_once('=').map(|(id, _)| id)).collect();
    let dangling: Vec<&str> = body.lines().flat_map(|l| l.split('#').skip(1).map(|s| s.split(|c: char| !c.is_ascii_digit()).next().unwrap()))
        .filter(|id| !id.is_empty() && !defined.contains(id)).collect();
    assert!(dangling.is_empty(), "{dangling:?}\n{out}");
    assert_eq!(out.lines().filter(|l| l.contains("=IFCRELSPACEBOUNDARY(")).count(), 2, "{out}");
    assert!(stats.warnings.iter().any(|w| w.contains("#33 (IFCRELASSOCIATESCLASSIFICATION) was omitted because a required IFC4 attribute lost a reference")), "{:?}", stats.warnings);
}
