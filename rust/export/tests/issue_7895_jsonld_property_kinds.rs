// SPDX-License-Identifier: MPL-2.0
//! #7895 follow-up: JSON-LD preserves the source property class after flat rendering.
use ifc_lite_export::{export_jsonld, export_jsonld_with_filter, JsonLdOptions};
use serde_json::{json, Value};

fn document(bytes: &[u8]) -> Value {
    serde_json::from_str(&export_jsonld(bytes, &JsonLdOptions::default())).unwrap()
}

#[test]
fn issue_7895_all_seven_property_classes_keep_their_values() {
    let doc = document(include_bytes!("fixtures/c6_data_model_synthetic.ifc"));
    let wall = doc["@graph"].as_array().unwrap().iter()
        .find(|node| node["ifc:expressId"] == 330).unwrap();
    let set = wall["ifc:hasPropertySets"].as_array().unwrap().iter()
        .find(|set| set["ifc:name"] == "Pset_AllKinds").unwrap();
    let props = set["ifc:hasProperties"].as_array().unwrap();
    assert_eq!(props.len(), 10);
    let expected = [
        ("Text", "IfcPropertySingleValue", json!("Fire ä proof")),
        ("Flag", "IfcPropertySingleValue", json!(true)),
        ("Unknown", "IfcPropertySingleValue", json!("unknown")),
        ("Thickness", "IfcPropertySingleValue", json!(0.2)),
        ("Status", "IfcPropertyEnumeratedValue", json!("NEW, EXISTING")),
        ("Range", "IfcPropertyBoundedValue", json!("2 [1 – 5]")),
        ("Sizes", "IfcPropertyListValue", json!("1, 2, 3")),
        ("Curve", "IfcPropertyTableValue", json!("Table (2 rows)")),
        ("Ref", "IfcPropertyReferenceValue", json!("Target")),
        ("Complex", "IfcComplexProperty", json!("Inner1: a, Inner2: 2.5")),
    ];
    for (property, (name, class, value)) in props.iter().zip(expected) {
        assert_eq!(property["ifc:name"], name);
        assert_eq!(property["@type"], format!("ifc:{class}"), "{name}");
        assert_eq!(property["ifc:nominalValue"], value, "{name}: value unchanged");
    }
}

fn ambiguous_fixture() -> Vec<u8> {
    // Same names, value tags AND rendered values cannot identify a class. Empty
    // sets, non-renderable values, missing references and quantities must not
    // shift the class of a subsequent emitted property. One shared set appears
    // on two products and directly on an orphan type product.
    br#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('a',$,'First',$,$,$,$,$,$);
#2=IFCWALL('b',$,'Second',$,$,$,$,$,$);
#3=IFCWALLTYPE('t',$,'Orphan',$,$,(#20,#21),(#40),$,$,.NOTDEFINED.);
#10=IFCPROPERTYSINGLEVALUE('Same',$,IFCLABEL('x'),$);
#11=IFCPROPERTYENUMERATEDVALUE('Same',$,(IFCLABEL('x')),$);
#12=IFCPROPERTYLISTVALUE('Same',$,(IFCLABEL('x')),$);
#13=IFCPROPERTYSINGLEVALUE('Absent',$,$,$);
#14=IFCPROPERTYSINGLEVALUE('',$,IFCLABEL('unused'),$);
#20=IFCPROPERTYSET('empty',$,'Empty',$,(#13,#14,#999));
#21=IFCPROPERTYSET('set',$,'Repeated',$,(#13,#10,#11,#14,#12));
#22=IFCELEMENTQUANTITY('quantity',$,'Qto',$,$,(#23));
#23=IFCQUANTITYLENGTH('Length',$,$,3.,$);
#30=IFCRELDEFINESBYPROPERTIES('rel',$,$,$,(#1,#2),(#20,#22,#21,#21));
#40=IFCREPRESENTATIONMAP($,$);
ENDSEC;
END-ISO-10303-21;"#.to_vec()
}

#[test]
fn issue_7895_classes_survive_omissions_shared_sets_and_orphan_type_rows() {
    let input = ambiguous_fixture();
    let opts = JsonLdOptions { include_quantities: true, ..Default::default() };
    let doc: Value = serde_json::from_str(&export_jsonld(&input, &opts)).unwrap();
    let graph = doc["@graph"].as_array().unwrap();
    assert_eq!(graph.len(), 3, "two occurrences and an orphan type row");
    for node in graph {
        let sets = node["ifc:hasPropertySets"].as_array().unwrap();
        assert_eq!(sets.len(), 1, "empty and duplicate definitions are omitted");
        let properties = sets[0]["ifc:hasProperties"].as_array().unwrap();
        assert_eq!(properties.len(), 3);
        for (property, class) in properties.iter().zip([
            "IfcPropertySingleValue", "IfcPropertyEnumeratedValue", "IfcPropertyListValue",
        ]) {
            assert_eq!(property["ifc:name"], "Same");
            assert_eq!(property["ifc:nominalValue"], "x");
            assert_eq!(property["@type"], format!("ifc:{class}"));
        }
        if node["ifc:expressId"] != 3 {
            assert_eq!(node["ifc:hasQuantitySets"][0]["ifc:quantities"][0]["@type"], "ifc:IfcQuantityLength");
        }
    }
}

#[test]
fn issue_7895_filters_and_property_opt_out_preserve_their_contracts() {
    let input = ambiguous_fixture();
    let opts = JsonLdOptions { included: vec![2], ..Default::default() };
    let doc: Value = serde_json::from_str(&export_jsonld(&input, &opts)).unwrap();
    assert_eq!(doc["@graph"].as_array().unwrap().len(), 1);
    assert_eq!(doc["@graph"][0]["ifc:expressId"], 2);
    assert_eq!(doc["@graph"][0]["ifc:hasPropertySets"][0]["ifc:hasProperties"][2]["@type"], "ifc:IfcPropertyListValue");
    let empty: Value = serde_json::from_str(&export_jsonld_with_filter(&input, &opts, Some(&[]))).unwrap();
    assert_eq!(empty["@graph"], json!([]));
    let opts = JsonLdOptions { include_properties: false, ..Default::default() };
    let doc: Value = serde_json::from_str(&export_jsonld(&input, &opts)).unwrap();
    assert_eq!(doc["@graph"].as_array().unwrap().len(), 3);
    assert!(doc["@graph"].as_array().unwrap().iter().all(|node| node.get("ifc:hasPropertySets").is_none()));
}

#[test]
fn issue_7895_classified_stream_preserves_the_existing_flat_model() {
    use ifc_lite_processing::data_model::rows::{build_export_model, stream_export_model_with_property_kinds};
    let input = ambiguous_fixture();
    let before = build_export_model(&input);
    let mut rows = Vec::new();
    let units = stream_export_model_with_property_kinds(&input, |row, kinds| {
        assert_eq!(row.property_sets.len(), kinds.len());
        for (set, kinds) in row.property_sets.iter().zip(kinds) {
            assert_eq!(set.properties.len(), kinds.len());
        }
        rows.push(row);
    });
    assert_eq!(rows, before.entities, "class metadata preserves all existing flat rows");
    assert_eq!(units, before.units);
}
