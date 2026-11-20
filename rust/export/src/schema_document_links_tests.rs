// SPDX-License-Identifier: MPL-2.0
use crate::step::{export_step_with_diagnostics, export_step_with_stats, StepOptions};

fn model(schema: &str, data: &str) -> String {
    format!("ISO-10303-21;HEADER;FILE_SCHEMA(('{schema}'));ENDSEC;DATA;\n{data}\nENDSEC;END-ISO-10303-21;")
}
fn to(schema: &str) -> StepOptions { StepOptions { schema: Some(schema.into()), ..StepOptions::default() } }
fn record(out: &str, id: &str) -> String { out.lines().find(|l| l.starts_with(id)).unwrap_or_default().to_string() }
/// The output and the count of values it had no slot for.
fn export(source: &str, options: &StepOptions) -> (String, usize) {
    let (out, stats) = export_step_with_stats(source.as_bytes(), options).unwrap();
    (out, stats.attribute_values_dropped)
}

const IFC2X3: &str = "#5=IFCDOCUMENTINFORMATION('D1','Doc',$,(#6,#7),$,$,$,$,$,$,$,$,$,$,$,$,$);\n#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$);\n#7=IFCDOCUMENTREFERENCE('b.pdf','B1',$);";

/// The issue: an upgrade wrote ReferencedDocument `$` and counted the listing
/// lost. Each listed reference now names its document, and the way back lists
/// them again, with nothing counted either way.
#[test]
fn the_document_link_moves_to_the_reference_and_back_10846() {
    for schema in ["IFC4", "IFC4X3"] {
        let (up, dropped) = export(&model("IFC2X3", IFC2X3), &to(schema));
        assert_eq!(record(&up, "#5="), "#5=IFCDOCUMENTINFORMATION('D1','Doc',$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);", "{schema}");
        assert_eq!(record(&up, "#6="), "#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,#5);", "{schema}");
        assert_eq!(record(&up, "#7="), "#7=IFCDOCUMENTREFERENCE('b.pdf','B1',$,$,#5);", "{schema}");
        assert_eq!(dropped, 0, "{schema}");
        let (back, dropped) = export(&up, &to("IFC2X3"));
        assert_eq!(record(&back, "#5="), "#5=IFCDOCUMENTINFORMATION('D1','Doc',$,(#6,#7),$,$,$,$,$,$,$,$,$,$,$,$,$);", "{schema}");
        assert_eq!(record(&back, "#6="), "#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$);", "{schema}");
        assert_eq!(dropped, 0, "{schema}");
    }
}

/// IFC2X3 lets one document list a reference: a second listing is reported,
/// and its document's listing stays counted.
#[test]
fn a_reference_listed_by_two_documents_keeps_the_first_10846() {
    let source = model("IFC2X3", &format!("{IFC2X3}\n#8=IFCDOCUMENTINFORMATION('D2','Other',$,(#6),$,$,$,$,$,$,$,$,$,$,$,$,$);"));
    let (out, stats, warnings) = export_step_with_diagnostics(source.as_bytes(), &to("IFC4")).unwrap();
    assert_eq!(record(&out, "#6="), "#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,#5);");
    assert_eq!(stats.attribute_values_dropped, 1);
    assert!(warnings.iter().any(|w| w.starts_with("1 IfcDocumentReference listing(s) past")), "{warnings:?}");
}

/// A reference repeated inside one list is not a second document.
#[test]
fn a_repeat_inside_one_list_is_not_reported_10846() {
    let source = model("IFC2X3", &IFC2X3.replace("(#6,#7)", "(#6,#6,#7)"));
    let (out, stats, warnings) = export_step_with_diagnostics(source.as_bytes(), &to("IFC4")).unwrap();
    assert_eq!(record(&out, "#6="), "#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,#5);");
    assert_eq!(stats.attribute_values_dropped, 0);
    assert!(!warnings.iter().any(|w| w.contains("IfcDocumentReference listing")), "{warnings:?}");
}

/// A subset has no source links to read, so the slot stays `$` and the
/// listing stays counted, as before.
#[test]
fn a_subset_export_arms_nothing_10846() {
    let options = StepOptions { included: Some(vec![5, 6, 7]), ..to("IFC4") };
    let (out, dropped) = export(&model("IFC2X3", IFC2X3), &options);
    assert_eq!(record(&out, "#6="), "#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,$);");
    assert_eq!(dropped, 1);
}

/// /code-review on the #10872 restack, the twin of the TypeScript case: a
/// repeated record id is its last copy, at that copy's place, so it is listed
/// once and in that order.
#[test]
fn a_repeated_reference_is_listed_once_at_its_last_place_10846() {
    let doc = "#5=IFCDOCUMENTINFORMATION('D1','Doc',$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);";
    let (a, b) = ("#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,#5);", "#7=IFCDOCUMENTREFERENCE('b.pdf','B1',$,$,#5);");
    let adjacent = export(&model("IFC4", &[doc, a, a, b].join("\n")), &to("IFC2X3")).0;
    assert_eq!(record(&adjacent, "#5="), "#5=IFCDOCUMENTINFORMATION('D1','Doc',$,(#6,#7),$,$,$,$,$,$,$,$,$,$,$,$,$);");
    let apart = export(&model("IFC4", &[doc, a, b, a].join("\n")), &to("IFC2X3")).0;
    assert_eq!(record(&apart, "#5="), "#5=IFCDOCUMENTINFORMATION('D1','Doc',$,(#7,#6),$,$,$,$,$,$,$,$,$,$,$,$,$);");
    // Kept as another type of the same arity, with a reference in the link slot: no reference.
    let wall = "#6=IFCDOCUMENTINFORMATIONRELATIONSHIP($,$,#5,(#5),#5);";
    let walled = export(&model("IFC4", &[doc, a, b, a, wall].join("\n")), &to("IFC2X3")).0;
    assert_eq!(record(&walled, "#5="), "#5=IFCDOCUMENTINFORMATION('D1','Doc',$,(#7),$,$,$,$,$,$,$,$,$,$,$,$,$);");
}

/// Claude review on #10872, the twin of the TypeScript case: IFC4 WR1 is
/// `EXISTS(Name) XOR EXISTS(ReferencedDocument)`, so a named reference that
/// gains its document drops the Name, counted and reported; an unlisted one
/// keeps it.
#[test]
fn a_reference_that_gains_its_document_drops_its_name_for_wr1_10846() {
    let named = format!("{}\n#8=IFCDOCUMENTREFERENCE('c.pdf','C1','Loose');", IFC2X3.replace("('a.pdf','A1',$)", "('a.pdf','A1','Title')"));
    for schema in ["IFC4", "IFC4X3"] {
        let (out, stats, warnings) = export_step_with_diagnostics(model("IFC2X3", &named).as_bytes(), &to(schema)).unwrap();
        assert_eq!(record(&out, "#6="), "#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,#5);", "{schema}");
        assert_eq!(record(&out, "#8="), "#8=IFCDOCUMENTREFERENCE('c.pdf','C1','Loose',$,$);", "{schema}");
        assert_eq!(stats.attribute_values_dropped, 1, "{schema}");
        assert!(warnings.iter().any(|w| w.starts_with("1 IfcDocumentReference Name(s) were dropped (the source breaks IFC2X3 WR1 too)")), "{schema}: {warnings:?}");
    }
    let (_, _, warnings) = export_step_with_diagnostics(model("IFC2X3", IFC2X3).as_bytes(), &to("IFC4")).unwrap();
    assert!(!warnings.iter().any(|w| w.contains("Name(s) were dropped")), "{warnings:?}");
}

/// /code-review, the twin of the TypeScript case: IfcExternalReference.WR1
/// needs Location, Identification or Name, so a reference a Name alone
/// identifies keeps it and stays unlinked; its document's listing is counted
/// lost, as for an unlisted member.
#[test]
fn a_reference_only_its_name_identifies_keeps_it_unlinked_10846() {
    let source = model("IFC2X3", &IFC2X3.replace("('a.pdf','A1',$)", "($,$,'Title')"));
    let (out, stats, warnings) = export_step_with_diagnostics(source.as_bytes(), &to("IFC4")).unwrap();
    assert_eq!(record(&out, "#6="), "#6=IFCDOCUMENTREFERENCE($,$,'Title',$,$);");
    assert_eq!(record(&out, "#7="), "#7=IFCDOCUMENTREFERENCE('b.pdf','B1',$,$,#5);");
    assert_eq!(stats.attribute_values_dropped, 1);
    assert!(warnings.iter().any(|w| w.starts_with("1 IfcDocumentReference(s) identified only by Name keep it and lose")), "{warnings:?}");
    assert!(!warnings.iter().any(|w| w.contains("Name(s) were dropped")), "{warnings:?}");
}
