// SPDX-License-Identifier: MPL-2.0
//! #4707: a typed value's name (`IFCREAL` in `IFCREAL(1.5)`) is a STEP keyword,
//! so its case is not significant (ISO 10303-21). The decoder kept the file's
//! spelling, and `typed_value` in the JSON exporter matches that name against
//! uppercase literals, so `ifcreal(1.5)` exported as the string `"1.5"` with a
//! `type` of `"ifcreal"` while `IFCREAL(1.5)` exported as the number 1.5.
//!
//! The lowercase and CamelCase runs must produce output identical to the
//! uppercase control. The control's own values are asserted too, so a fixture
//! whose property never reaches the output cannot pass trivially.

use ifc_lite_export::{export_json, JsonOptions};
use serde_json::Value;

fn model(real: &str, ratio: &str, boolean: &str) -> String {
    format!(
        concat!(
            "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n",
            "#10=IFCWALL('0Ab1c2d3e4f5g6h7i8j9k0',$,'Wall',$,$,$,$,$,$);\n",
            "#20=IFCPROPERTYSINGLEVALUE('Ratio',$,{real}(1.5),$);\n",
            "#21=IFCPROPERTYSINGLEVALUE('Share',$,{ratio}(0.25),$);\n",
            "#22=IFCPROPERTYSINGLEVALUE('Flag',$,{boolean}(.T.),$);\n",
            "#30=IFCPROPERTYSET('1Ab1c2d3e4f5g6h7i8j9k0',$,'Pset_X',$,(#20,#21,#22));\n",
            "#40=IFCRELDEFINESBYPROPERTIES('2Ab1c2d3e4f5g6h7i8j9k0',$,$,$,(#10),#30);\n",
            "ENDSEC;\nEND-ISO-10303-21;\n",
        ),
        real = real,
        ratio = ratio,
        boolean = boolean,
    )
}

fn wall_properties(step: &str) -> Value {
    let json = export_json(step.as_bytes(), &JsonOptions::default());
    let rows: Value = serde_json::from_str(&json).expect("export_json emits valid JSON");
    rows.as_array()
        .expect("top level is an array")
        .iter()
        .find(|row| row["expressId"] == 10)
        .expect("#10 IfcWall is exported")["propertySets"]
        .clone()
}

fn property<'a>(psets: &'a Value, name: &str) -> &'a Value {
    psets[0]["properties"]
        .as_array()
        .expect("Pset_X has properties")
        .iter()
        .find(|p| p["name"] == name)
        .unwrap_or_else(|| panic!("property {name} exported; got {psets}"))
}

#[test]
fn issue_4707_lowercase_ifcreal_exports_as_a_number_with_the_canonical_type() {
    let upper = wall_properties(&model("IFCREAL", "IFCNORMALISEDRATIOMEASURE", "IFCBOOLEAN"));
    let ratio = property(&upper, "Ratio");
    assert_eq!(ratio["value"], serde_json::json!(1.5), "control: IFCREAL is a number");
    assert_eq!(ratio["type"], "IFCREAL");

    let lower = wall_properties(&model("ifcreal", "ifcnormalisedratiomeasure", "ifcboolean"));
    let ratio = property(&lower, "Ratio");
    assert_eq!(ratio["value"], serde_json::json!(1.5), "ifcreal(1.5) must stay a number");
    assert_eq!(ratio["type"], "IFCREAL", "the type tag is the EXPRESS spelling");
    assert_eq!(lower, upper, "lowercase keywords export identically to uppercase");

    let camel = wall_properties(&model("IfcReal", "IfcNormalisedRatioMeasure", "IfcBoolean"));
    assert_eq!(camel, upper, "CamelCase keywords export identically to uppercase");
    assert_eq!(property(&camel, "Flag")["value"], serde_json::json!(true));
}
