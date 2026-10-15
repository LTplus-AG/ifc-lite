// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7681: property data lost or mistyped on the data exports.
//!
//! EXPORT-DATA-1: `IfcRelDefinesByProperties.RelatingPropertyDefinition` is an
//! `IfcPropertySetDefinitionSelect`. Besides a single reference it may hold an
//! `IfcPropertySetDefinitionSet`, written as a bare list `(#20,#22)` or, as
//! ISO 10303-21 spells a defined type inside a SELECT, as the typed parameter
//! `IFCPROPERTYSETDEFINITIONSET((#20,#22))`. The export model read only the
//! single reference and skipped the relationship otherwise, so CSV, JSON,
//! JSON-LD, IFCX, Parquet and the Python binding lost every set attached that
//! way, while the opt-in quantity analysis reported them for the same file.
//!
//! EXPORT-DATA-8: JSON kept a value a number only when its type tag was on an
//! 11-entry allowlist, so `IFCTHERMALTRANSMITTANCEMEASURE(0.24)` became the
//! string `"0.24"`.
//!
//! EXPORT-DATA-28: the flattened CSV header `{pset}_{prop}` gave
//! `("Pset_A", "B_C")` and `("Pset_A_B", "C")` the same column name.

use std::collections::HashSet;

use ifc_lite_export::{
    analyze_authored_quantities, build_export_model, export_csv, export_json, export_jsonld,
    CsvMode, CsvOptions, JsonLdOptions, JsonOptions,
};
use serde_json::{json, Value};

const HEAD: &str = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n";
const TAIL: &str = "ENDSEC;\nEND-ISO-10303-21;\n";

/// One wall per spelling of RelatingPropertyDefinition, all pointing at the
/// same property set (#20) and quantity set (#22).
fn definition_set_model() -> String {
    format!(
        "{HEAD}\
#1=IFCPROJECT('0PROJ00000000000000001',$,'P',$,$,$,$,$,$);\n\
#10=IFCWALL('0WALL00000000000000010',$,'Single',$,$,$,$,$,$);\n\
#11=IFCWALL('0WALL00000000000000011',$,'BareList',$,$,$,$,$,$);\n\
#12=IFCWALL('0WALL00000000000000012',$,'Typed',$,$,$,$,$,$);\n\
#20=IFCPROPERTYSET('0PSET00000000000000020',$,'Pset_A',$,(#21));\n\
#21=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('R60'),$);\n\
#22=IFCELEMENTQUANTITY('0QTO000000000000000022',$,'Qto_B',$,$,(#23));\n\
#23=IFCQUANTITYLENGTH('Width',$,$,0.2,$);\n\
#30=IFCRELDEFINESBYPROPERTIES('0REL00000000000000030',$,$,$,(#10),#20);\n\
#31=IFCRELDEFINESBYPROPERTIES('0REL00000000000000031',$,$,$,(#10),#22);\n\
#32=IFCRELDEFINESBYPROPERTIES('0REL00000000000000032',$,$,$,(#11),(#20,#22));\n\
#33=IFCRELDEFINESBYPROPERTIES('0REL00000000000000033',$,$,$,(#12),IFCPROPERTYSETDEFINITIONSET((#20,#22)));\n\
{TAIL}"
    )
}

#[test]
fn export_data_1_every_relating_definition_shape_reaches_the_rows() {
    let ifc = definition_set_model();
    let model = build_export_model(ifc.as_bytes());
    for id in [10, 11, 12] {
        let row = model.entities.iter().find(|r| r.express_id == id).expect("wall row");
        let psets: Vec<_> = row.property_sets.iter().map(|p| p.name.as_str()).collect();
        let qsets: Vec<_> = row.quantity_sets.iter().map(|q| q.name.as_str()).collect();
        assert_eq!(psets, ["Pset_A"], "#{id} {:?}", row.name);
        assert_eq!(qsets, ["Qto_B"], "#{id} {:?}", row.name);
        assert_eq!(row.lookup("Pset_A", "FireRating").as_deref(), Some("R60"));
    }

    // The flat exports read the same rows: one property row per wall.
    let csv = export_csv(ifc.as_bytes(), CsvMode::Properties, &CsvOptions::default());
    for id in ["10", "11", "12"] {
        assert!(
            csv.lines().any(|line| line.starts_with(&format!("{id},")) && line.contains("Pset_A")),
            "#{id} lost Pset_A in the properties CSV:\n{csv}"
        );
    }

    // The opt-in quantity analysis already read both forms; the two outputs
    // must now agree on which walls carry Qto_B.
    let analysis = analyze_authored_quantities(ifc.as_bytes(), Some(&HashSet::from([10, 11, 12])));
    for id in [10, 11, 12] {
        assert!(
            analysis.products[&id].authored.iter().any(|q| q.set_name == "Qto_B"),
            "quantity analysis lost Qto_B on #{id}"
        );
    }
}

/// A SET holds each definition once. `(#20,#20)`, or two relationships naming
/// #20 for one object, must not export the property set twice.
#[test]
fn export_data_1_a_repeated_definition_is_exported_once() {
    let ifc = format!(
        "{HEAD}\
#10=IFCWALL('0WALL00000000000000010',$,'Repeated',$,$,$,$,$,$);\n\
#11=IFCWALL('0WALL00000000000000011',$,'TwoRels',$,$,$,$,$,$);\n\
#12=IFCWALL('0WALL00000000000000012',$,'TypedRepeated',$,$,$,$,$,$);\n\
#20=IFCPROPERTYSET('0PSET00000000000000020',$,'Pset_A',$,(#21));\n\
#21=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('R60'),$);\n\
#30=IFCRELDEFINESBYPROPERTIES('0REL00000000000000030',$,$,$,(#10),(#20,#20));\n\
#31=IFCRELDEFINESBYPROPERTIES('0REL00000000000000031',$,$,$,(#11),#20);\n\
#32=IFCRELDEFINESBYPROPERTIES('0REL00000000000000032',$,$,$,(#11),(#20));\n\
#33=IFCRELDEFINESBYPROPERTIES('0REL00000000000000033',$,$,$,(#12),IFCPROPERTYSETDEFINITIONSET((#20,#20)));\n\
{TAIL}"
    );
    let model = build_export_model(ifc.as_bytes());
    for id in [10, 11, 12] {
        let row = model.entities.iter().find(|r| r.express_id == id).expect("wall row");
        let psets: Vec<_> = row.property_sets.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(psets, ["Pset_A"], "#{id} {:?}", row.name);
    }
}

/// One property per primitive spelling: measures outside the old allowlist,
/// text that looks numeric or boolean, and the logical/boolean forms.
fn typed_values_model() -> String {
    let values = [
        ("UValue", "IFCTHERMALTRANSMITTANCEMEASURE(0.24)"),
        ("Angle", "IFCPLANEANGLEMEASURE(90.)"),
        ("Power", "IFCPOWERMEASURE(1500)"),
        ("Share", "IFCPOSITIVERATIOMEASURE(0.5)"),
        ("Cost", "IFCMONETARYMEASURE(12.5)"),
        ("Duration", "IFCTIMEMEASURE(3600.)"),
        ("Count", "IFCINTEGER(4)"),
        ("Plain", "2.5"),
        ("Label", "IFCLABEL('0.5')"),
        ("Ident", "IFCIDENTIFIER('12')"),
        ("Text", "IFCTEXT('true')"),
        ("IsExternal", "IFCBOOLEAN(.T.)"),
        ("Bare", ".F."),
        ("Unknown", "IFCLOGICAL(.U.)"),
    ];
    let mut ifc = format!("{HEAD}#10=IFCWALL('0WALL00000000000000010',$,'W',$,$,$,$,$,$);\n");
    let mut ids = Vec::new();
    for (i, (name, value)) in values.iter().enumerate() {
        let id = 100 + i;
        ifc.push_str(&format!("#{id}=IFCPROPERTYSINGLEVALUE('{name}',$,{value},$);\n"));
        ids.push(format!("#{id}"));
    }
    ifc.push_str(&format!(
        "#20=IFCPROPERTYSET('0PSET00000000000000020',$,'Pset_T',$,({}));\n\
         #30=IFCRELDEFINESBYPROPERTIES('0REL00000000000000030',$,$,$,(#10),#20);\n{TAIL}",
        ids.join(",")
    ));
    ifc
}

fn expected_typed_values() -> Vec<(&'static str, Value)> {
    vec![
        ("UValue", json!(0.24)),
        ("Angle", json!(90.0)),
        ("Power", json!(1500.0)),
        ("Share", json!(0.5)),
        ("Cost", json!(12.5)),
        ("Duration", json!(3600.0)),
        ("Count", json!(4.0)),
        ("Plain", json!(2.5)),
        ("Label", json!("0.5")),
        ("Ident", json!("12")),
        ("Text", json!("true")),
        ("IsExternal", json!(true)),
        ("Bare", json!(false)),
        ("Unknown", json!("unknown")),
    ]
}

#[test]
fn export_data_8_numbers_stay_numbers_whatever_their_measure_type() {
    let ifc = typed_values_model();
    let json: Value = serde_json::from_str(&export_json(ifc.as_bytes(), &JsonOptions::default()))
        .expect("valid JSON");
    let props = json[0]["propertySets"][0]["properties"].as_array().expect("properties");
    let jsonld: Value =
        serde_json::from_str(&export_jsonld(ifc.as_bytes(), &JsonLdOptions::default()))
            .expect("valid JSON-LD");
    let graph = jsonld["@graph"].as_array().expect("@graph");
    let wall = graph.iter().find(|n| n["ifc:name"] == "W").expect("wall node");
    let ld_props = wall["ifc:hasPropertySets"][0]["ifc:hasProperties"].as_array().expect("props");
    for (name, expected) in expected_typed_values() {
        let p = props.iter().find(|p| p["name"] == name).expect(name);
        assert_eq!(p["value"], expected, "JSON {name} ({})", p["type"]);
        let p = ld_props.iter().find(|p| p["ifc:name"] == name).expect(name);
        assert_eq!(p["ifc:nominalValue"], expected, "JSON-LD {name}");
    }
}

#[test]
fn export_data_28_flattened_csv_headers_are_unique() {
    let ifc = format!(
        "{HEAD}\
#10=IFCWALL('0WALL00000000000000010',$,'W',$,$,$,$,$,$);\n\
#21=IFCPROPERTYSINGLEVALUE('B_C',$,IFCLABEL('first'),$);\n\
#22=IFCPROPERTYSINGLEVALUE('C',$,IFCLABEL('second'),$);\n\
#23=IFCPROPERTYSINGLEVALUE('C (2)',$,IFCLABEL('third'),$);\n\
#20=IFCPROPERTYSET('0PSET00000000000000020',$,'Pset_A',$,(#21));\n\
#24=IFCPROPERTYSET('0PSET00000000000000024',$,'Pset_A_B',$,(#22,#23));\n\
#30=IFCRELDEFINESBYPROPERTIES('0REL00000000000000030',$,$,$,(#10),#20);\n\
#31=IFCRELDEFINESBYPROPERTIES('0REL00000000000000031',$,$,$,(#10),#24);\n\
{TAIL}"
    );
    let opts = CsvOptions { include_properties: true, ..CsvOptions::default() };
    let csv = export_csv(ifc.as_bytes(), CsvMode::Entities, &opts);
    let mut lines = csv.lines();
    let header: Vec<&str> = lines.next().expect("header").split(',').collect();
    let unique: HashSet<&&str> = header.iter().collect();
    assert_eq!(unique.len(), header.len(), "duplicate CSV header: {header:?}");
    // Every value keeps a column of its own: none was merged into another.
    let row: Vec<&str> = lines.next().expect("wall row").split(',').collect();
    for value in ["first", "second", "third"] {
        assert_eq!(row.iter().filter(|cell| **cell == value).count(), 1, "{value}: {header:?} / {row:?}");
    }
    // The first column keeps the documented `{pset}_{prop}` name.
    assert!(header.contains(&"Pset_A_B_C"), "{header:?}");
}
