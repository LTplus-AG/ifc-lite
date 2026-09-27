// SPDX-License-Identifier: MPL-2.0
//! #5787: source reuse and authored provenance are distinct observations.

use super::*;

const MAPPED: &[u8] = include_bytes!("../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");

fn approx(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-9 * expected.abs().max(1.0),
        "actual {actual}, expected {expected}");
}

#[test]
fn mapped_products_share_one_source_but_keep_distinct_occurrences() {
    let ids = HashSet::from([31, 38]);
    let view = analyze_quantities(MAPPED, Some(&ids));
    assert!(view.diagnostics.is_empty(), "{:?}", view.diagnostics);
    assert_eq!((view.product_count, view.source_occurrence_count, view.unique_source_count), (2, 2, 1));
    let first = &view.products[&31];
    let second = &view.products[&38];
    assert_eq!(first.sources[0].source, second.sources[0].source);
    assert_eq!(first.sources[0].solid_id, 12);
    assert_eq!(first.sources[0].status, "complete");
    assert_eq!(first.sources[0].quantities.iter().find(|q| q.name == "Depth").unwrap().origin,
        "authored_source_parameter");
    approx(first.sources[0].quantities.iter().find(|q| q.name == "nominal_volume").unwrap().value, 1.0);
    assert!(first.product_total.is_none());
    assert!(second.product_total.is_none());
    assert_eq!(analyze_quantities(MAPPED, Some(&HashSet::new())).product_count, 0);
}

#[test]
fn repeated_source_in_one_product_is_not_summed_twice() {
    let source = String::from_utf8(MAPPED.to_vec()).unwrap();
    let repeated = source.replace(
        "#26=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',(#25));",
        "#26=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',(#25,#32));");
    assert_ne!(source, repeated);
    let view = analyze_quantities(repeated.as_bytes(), Some(&HashSet::from([31])));
    assert_eq!(view.products[&31].source_occurrence_count, 2, "{:?}", view.diagnostics);
    assert_eq!(view.products[&31].unique_source_count, 1);
    assert!(view.products[&31].aggregate_diagnostic.contains("Multiple source uses"));
    assert!(view.products[&31].product_total.is_none());
}

#[test]
fn authored_length_is_preserved_even_when_it_disagrees_with_exact_directrix() {
    let source = String::from_utf8(include_bytes!("../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc").to_vec()).unwrap();
    let modified = source.replace("ENDSEC;\nEND-ISO-10303-21;",
        "#900=IFCQUANTITYLENGTH('Length',$,$,1000.,$);\n#901=IFCELEMENTQUANTITY('0QTO',$,'Qto_Bar',$,$,(#900));\n#902=IFCRELDEFINESBYPROPERTIES('0REL',$,$,$,(#50),#901);\nENDSEC;\nEND-ISO-10303-21;");
    assert_ne!(source, modified);
    let view = analyze_quantities(modified.as_bytes(), Some(&HashSet::from([50])));
    let product = &view.products[&50];
    assert_eq!(product.authored[0].value, 1000.0);
    let length = product.sources[0].quantities.iter().find(|q| q.name == "centreline_length").unwrap();
    approx(length.value, 2.75);
    assert_eq!(length.unit, "m");
    assert_eq!(length.origin, "derived");
    assert!(length.limitation.contains("cutting allowances"));
    assert!(product.product_total.is_none());
}

#[test]
fn real_revit_wall_keeps_holed_source_as_nominal_not_product_volume() {
    let bytes = include_bytes!("../../geometry/tests/fixtures/issue_098_wall_W.ifc");
    let view = analyze_quantities(bytes, Some(&HashSet::from([928638, 928672])));
    assert_eq!(view.product_count, 2);
    let source = view.products.values().flat_map(|p| &p.sources)
        .find(|source| source.solid_id == 338107).expect("real authored Revit profile");
    assert_eq!(source.source_kind, "IfcExtrudedAreaSolid");
    // Independent oracle from the IFC STEP loops: outer rectangle is 2.5 × 0.8 m,
    // inner opening is 2.41 × 0.71 m, and #338107 has Depth = 0.06 m.
    let area = source.quantities.iter().find(|q| q.name == "profile_area").unwrap();
    let volume = source.quantities.iter().find(|q| q.name == "nominal_volume").unwrap();
    approx(area.value, 2.5 * 0.8 - 2.41 * 0.71);
    approx(volume.value, (2.5 * 0.8 - 2.41 * 0.71) * 0.06);
    assert!(view.products.values().all(|product| product.product_total.is_none()));
}

#[test]
fn csg_repeated_operand_reports_modification_and_no_product_total() {
    let source = String::from_utf8(MAPPED.to_vec()).unwrap();
    let csg = source.replace(
        "#13=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#12));",
        "#13=IFCSHAPEREPRESENTATION(#5,'Body','SolidModel',(#500));",
    ).replace("ENDSEC;\nEND-ISO-10303-21;",
        "#500=IFCBOOLEANRESULT(.UNION.,#12,#12);\nENDSEC;\nEND-ISO-10303-21;");
    let view = analyze_quantities(csg.as_bytes(), Some(&HashSet::from([31])));
    let product = &view.products[&31];
    assert_eq!((product.source_occurrence_count, product.unique_source_count), (2, 1));
    assert!(product.sources.iter().all(|source| source.source_modified &&
        source.status == "source_modified"));
    assert!(product.aggregate_diagnostic.contains("CSG"));
    assert!(product.product_total.is_none());
}

#[test]
fn csg_unsupported_operand_preserves_both_provenance_and_failure_reason() {
    let source = String::from_utf8(MAPPED.to_vec()).unwrap();
    let csg = source.replace(
        "#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);",
        "#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,-1.0);",
    ).replace(
        "#13=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#12));",
        "#13=IFCSHAPEREPRESENTATION(#5,'Body','SolidModel',(#500));",
    ).replace("ENDSEC;\nEND-ISO-10303-21;",
        "#500=IFCBOOLEANRESULT(.UNION.,#12,#12);\nENDSEC;\nEND-ISO-10303-21;");
    let view = analyze_quantities(csg.as_bytes(), Some(&HashSet::from([31])));
    let product = &view.products[&31];
    assert_eq!(product.source_occurrence_count, 2);
    for source in &product.sources {
        assert!(source.source_modified);
        assert_eq!(source.status, "unsupported");
        assert!(source.status_reason.as_deref().is_some_and(|reason| reason.contains("Depth")));
        assert!(source.quantities.is_empty());
    }
    assert!(product.product_total.is_none());
}

#[test]
fn distinct_solids_in_one_product_are_counted_without_summing() {
    let source = String::from_utf8(MAPPED.to_vec()).unwrap();
    let multiple = source.replace(
        "#13=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#12));",
        "#1000=IFCEXTRUDEDAREASOLID(#8,#11,#9,2.0);\n#13=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#12,#1000));",
    );
    let view = analyze_quantities(multiple.as_bytes(), Some(&HashSet::from([31])));
    let product = &view.products[&31];
    assert_eq!((product.source_occurrence_count, product.unique_source_count), (2, 2), "sources={:?}, diagnostics={:?}", product.sources, view.diagnostics);
    assert_eq!(product.sources.iter().map(|source| source.solid_id).collect::<Vec<_>>(), vec![12, 1000]);
    assert!(product.aggregate_diagnostic.contains("Multiple source uses"));
    assert!(product.product_total.is_none());
}

#[test]
fn unsupported_occurrence_does_not_imply_certified_quantities() {
    let source = String::from_utf8(include_bytes!("../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc").to_vec()).unwrap();
    let nonuniform = source.replace(
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);",
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#10,$,$,2.,1.);",
    );
    let view = analyze_quantities(nonuniform.as_bytes(), Some(&HashSet::from([50])));
    let product = &view.products[&50];
    assert_eq!(product.sources[0].status, "unsupported");
    assert!(product.sources[0].status_reason.is_some());
    assert!(product.sources[0].quantities.is_empty());
    assert!(product.product_total.is_none());
    assert!(product.aggregate_diagnostic.contains("Unsupported"));
}
