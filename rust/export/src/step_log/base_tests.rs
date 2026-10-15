// SPDX-License-Identifier: MPL-2.0
use super::*;

/// #5475: a reference property's base value is the referenced object's Name,
/// else its Identification, else `#<id>`, read from slot 3
/// (`PropertyReference`), never slot 2 (`UsageName`). Top level and inside a
/// complex property alike, as `parsePropertyValueWithComplex` reads them.
#[test]
fn a_reference_property_reads_the_referenced_name() {
    let text = "ISO-10303-21;\nHEADER;FILE_SCHEMA(('IFC4'));ENDSEC;\nDATA;\n\
#5=IFCMATERIAL('Oak',$,$);\n\
#6=IFCCLASSIFICATIONREFERENCE($,'Ss_25',$,$,$,$);\n\
#7=IFCCLASSIFICATIONREFERENCE($,$,$,$,$,$);\n\
#10=IFCWALL('0WallA0000000000000010A',$,'Wall',$,$,$,$,$,$);\n\
#11=IFCPROPERTYREFERENCEVALUE('Finish',$,'finish usage',#5);\n\
#12=IFCPROPERTYREFERENCEVALUE('Spec',$,$,#6);\n\
#13=IFCPROPERTYREFERENCEVALUE('Bare',$,$,#7);\n\
#14=IFCCOMPLEXPROPERTY('Layer',$,'usage',(#11));\n\
#15=IFCPROPERTYSET('0Pset00000000000000015A',$,'Pset_Ref',$,(#11,#12,#13,#14));\n\
#16=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000016A',$,$,$,(#10),#15);\n\
ENDSEC;\nEND-ISO-10303-21;\n";
    let src = Source::index(text.as_bytes());
    let mut base = BaseSets::new(&src, &HashSet::from([10]));
    let sets = base.psets(10);
    let values: Vec<(String, Value)> = sets[0].properties.iter().map(|p| (p.name.clone(), p.value.clone())).collect();
    assert_eq!(
        values,
        vec![
            ("Finish".to_string(), Value::String("Oak".into())),
            ("Spec".to_string(), Value::String("Ss_25".into())),
            ("Bare".to_string(), Value::String("#7".into())),
            ("Layer".to_string(), Value::String("Finish: Oak".into())),
        ]
    );
}

/// #7675: the exporter's property base is the third copy of the
/// `IfcComplexProperty` walk, and a regenerated set is written from it, so it
/// must give the same value as the TS walk the TypeScript exporter uses and
/// the server's. All three read one vector; bounds and markers come from
/// `ifc_lite_core::limits`.
#[test]
fn complex_property_walk_budget_matches_the_shared_vector() {
    let vector: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/parser/test/fixtures/complex-property-budget-7675.json"
    ))
    .expect("vector parses");
    let data: Vec<&str> = vector["dataLines"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
    let text = format!(
        "ISO-10303-21;\nHEADER;FILE_SCHEMA(('IFC4'));ENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        data.join("\n")
    );
    let wall = vector["wallId"].as_u64().unwrap() as u32;
    let src = Source::index(text.as_bytes());
    let mut base = BaseSets::new(&src, &HashSet::from([wall]));
    let sets: Vec<(String, Vec<(String, String)>)> = base
        .psets(wall)
        .into_iter()
        .map(|set| {
            let props = set
                .properties
                .iter()
                .map(|p| (p.name.clone(), p.value.as_str().unwrap_or("").to_string()))
                .collect();
            (set.name, props)
        })
        .collect();
    assert_complex_budget_vector(&vector, &sets);
}

/// Check one walk's property sets (name, then `(property, value)` in order)
/// against the shared #7675 vector. The TS and exporter tests read the same
/// file with the same rules: an inline `value` is exact, a long one is pinned
/// by UTF-8 length and SHA-256, a repeated property by its values joined with
/// `\n`, and every value together stays under `maxTotalBytes`.
fn assert_complex_budget_vector(vector: &serde_json::Value, sets: &[(String, Vec<(String, String)>)]) {
    use sha2::{Digest, Sha256};
    let digest = |text: &str| -> (u64, String) {
        let hash: String = Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        (text.len() as u64, hash)
    };
    let pinned = |case: &serde_json::Value| (case["length"].as_u64().unwrap(), case["sha256"].as_str().unwrap().to_string());
    let total: usize = sets.iter().flat_map(|(_, props)| props.iter().map(|(_, v)| v.len())).sum();
    assert!(total as u64 <= vector["maxTotalBytes"].as_u64().unwrap(), "{total} bytes of property values");
    for expected in vector["psets"].as_array().unwrap() {
        let name = expected["name"].as_str().unwrap();
        let (_, props) = sets.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("{name} missing"));
        if let Some(repeated) = expected.get("repeated") {
            assert_eq!(props.len() as u64, repeated["count"].as_u64().unwrap(), "{name}");
            let joined = props.iter().map(|(_, v)| v.as_str()).collect::<Vec<_>>().join("\n");
            assert_eq!(digest(&joined), pinned(repeated), "{name}");
            continue;
        }
        for case in expected["properties"].as_array().unwrap() {
            let property = case["property"].as_str().unwrap();
            let value = &props.iter().find(|(n, _)| n == property).unwrap_or_else(|| panic!("{property} missing")).1;
            match case.get("value") {
                Some(exact) => assert_eq!(value, exact.as_str().unwrap(), "{property}"),
                None => assert_eq!(digest(value), pinned(case), "{property}"),
            }
        }
    }
}
