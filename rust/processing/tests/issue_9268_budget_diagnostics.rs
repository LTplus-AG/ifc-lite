// SPDX-License-Identifier: MPL-2.0
//! #9268: real walk refusal through the public native processing API.
use ifc_lite_processing::{process, ProcessingRequest};
fn source(items: usize) -> String {
    let ids: Vec<String> = (0..items).map(|i| format!("#{}", 1000 + i)).collect();
    let members: String = ids
        .iter()
        .map(|id| format!("{id}=IFCSHELLBASEDSURFACEMODEL((#7));\n"))
        .collect();
    format!(
        "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('mapped breadth regression'),'2;1');
FILE_NAME('mapped.ifc','2026-11-06T00:00:00',(),(),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((1.,0.,0.));
#3=IFCCARTESIANPOINT((0.,1.,0.));
#4=IFCPOLYLOOP((#1,#2,#3));
#5=IFCFACEOUTERBOUND(#4,.T.);
#6=IFCFACE((#5));
#7=IFCOPENSHELL((#6));
#9=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);
#10=IFCAXIS2PLACEMENT3D(#1,$,$);
#11=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,0.00001,#10,$);
#20=IFCSHAPEREPRESENTATION(#11,'Body','SurfaceModel',({}));
#21=IFCREPRESENTATIONMAP(#10,#20);
#22=IFCMAPPEDITEM(#21,#9);
#23=IFCSHAPEREPRESENTATION(#11,'Body','MappedRepresentation',(#22));
#24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#25=IFCFLOWTERMINAL('0000000000000000000001',$,'synthetic mapped surface',$,$,$,#24,$);
{members}ENDSEC;
END-ISO-10303-21;
",
        ids.join(",")
    )
}

#[test]
fn issue_9268_budget_refusal_is_not_an_unsupported_mapped_item() {
    let members = vec!["#22"; 65_538].join(",");
    let content = source(1).replace("MappedRepresentation',(#22)", &format!("MappedRepresentation',({members})"));
    let result = process(content.as_bytes(), &ProcessingRequest::default(), &mut ());
    let diag = result.stats.geometry_diagnostics.expect("budget refusal is diagnostic-worthy");
    let json = serde_json::to_value(&diag).unwrap();
    assert_eq!(json["totalUnsupportedItems"], 0, "budget refusal is not unsupported");
    assert_eq!(json["totalCsgFailures"], 0);
    let refusals = json["budgetRefusals"].as_array().expect("distinct budget class");
    assert_eq!(refusals.len(), 1);
    let refusal = &refusals[0];
    assert_eq!(refusal["budget"], "walk Items members");
    assert_eq!(refusal["limit"], 65_536);
    assert_eq!(refusal["reached"], 65_537);
    assert_eq!(refusal["productId"], 25);
    assert_eq!(refusal["productType"], "IfcFlowTerminal");
    assert_eq!(refusal["GlobalId"], "0000000000000000000001");
    assert_eq!(refusal["sourceId"], 23);
}

#[test]
fn issue_9268_real_unsupported_item_stays_unsupported() {
    let content = source(1).replace("#1000=IFCSHELLBASEDSURFACEMODEL((#7));", "#1000=IFCCARTESIANPOINT((0.,0.,0.));");
    // A second product hits the budget, so reverting the fix also fails this
    // negative control: its refusal must not inflate the genuine drop count.
    let members = vec!["#22"; 65_538].join(",");
    let content = content.replace("ENDSEC;\nEND-ISO", &format!(
        "#123=IFCSHAPEREPRESENTATION(#11,'Body','MappedRepresentation',({members}));\n#124=IFCPRODUCTDEFINITIONSHAPE($,$,(#123));\n#125=IFCFLOWTERMINAL('0000000000000000000002',$,'budget',$,$,$,#124,$);\nENDSEC;\nEND-ISO"));
    let result = process(content.as_bytes(), &ProcessingRequest::default(), &mut ());
    let diag = result.stats.geometry_diagnostics.expect("unsupported item diagnostic");
    assert_eq!(diag.total_unsupported_items, 1);
    assert_eq!(diag.unsupported_items_by_type[0].reason, "IfcCartesianPoint");
    let json = serde_json::to_value(diag).unwrap();
    assert_eq!(json["budgetRefusals"].as_array().unwrap().len(), 1);
    assert_eq!(json["totalBudgetRefusals"], 1);
    assert_eq!(json["budgetRefusals"][0]["productId"], 125);
}

#[test]
fn issue_9268_type_map_refusal_names_the_type_product() {
    let members = vec!["#1000"; 65_538].join(",");
    let content = source(1)
        .replace("SurfaceModel',(#1000)", &format!("SurfaceModel',({members})"))
        .replace("#25=IFCFLOWTERMINAL('0000000000000000000001',$,'synthetic mapped surface',$,$,$,#24,$);",
            "#60=IFCWALLTYPE('type-guid',$,'budget type',$,$,$,(#21),$,$,.NOTDEFINED.);");
    let result = process(content.as_bytes(), &ProcessingRequest::default(), &mut ());
    let diag = result.stats.geometry_diagnostics.expect("type budget refusal is diagnostic-worthy");
    assert_eq!(diag.total_unsupported_items, 0);
    assert_eq!(diag.total_budget_refusals, 1);
    assert_eq!(diag.budget_refusals.len(), 1);
    let refusal = &diag.budget_refusals[0];
    assert_eq!(refusal.product_id, Some(60));
    assert_eq!(refusal.product_type.as_deref(), Some("IfcWallType"));
    assert_eq!(refusal.global_id.as_deref(), Some("type-guid"));
    assert_eq!((refusal.source_id, refusal.limit, refusal.reached), (21, 65_536, 65_537));
}
