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
/// the server's, for every entity that asks. All three read one vector;
/// bounds, markers and charges come from `ifc_lite_core::limits`.
#[test]
fn complex_property_walk_budget_matches_the_shared_vector() {
    let vector: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/parser/test/fixtures/complex-property-budget-7675.json"
    ))
    .expect("vector parses");
    for case in vector["cases"].as_array().unwrap() {
        let data: Vec<&str> = case["dataLines"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
        let text = format!(
            "ISO-10303-21;\nHEADER;FILE_SCHEMA(('IFC4'));ENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
            data.join("\n")
        );
        let entities: Vec<u32> = case["entityIds"].as_array().unwrap().iter().map(|id| id.as_u64().unwrap() as u32).collect();
        let src = Source::index(text.as_bytes());
        let mut base = BaseSets::new(&src, &entities.iter().copied().collect());
        for &entity in &entities {
            let sets: Vec<(String, Vec<String>)> = base
                .psets(entity)
                .into_iter()
                .map(|set| {
                    let values = set.properties.iter().map(|p| p.value.as_str().unwrap_or("").to_string()).collect();
                    (set.name, values)
                })
                .collect();
            assert_complex_budget_case(case, text.len(), &sets);
        }
    }
}

/// Check one walk's property sets (name, then the values in order) against
/// one case of the shared #7675 vector. The TS and server tests read the same
/// file with the same rules: a set is pinned by its property count and its
/// values joined with `\n` (inline when short, else UTF-8 length and SHA-256),
/// and the values together stay within the model's output budget.
fn assert_complex_budget_case(case: &serde_json::Value, input_bytes: usize, sets: &[(String, Vec<String>)]) {
    use sha2::{Digest, Sha256};
    let total: usize = sets.iter().flat_map(|(_, values)| values.iter().map(String::len)).sum();
    let budget = ifc_lite_core::limits::complex_property_output_budget(input_bytes);
    assert!(total <= budget, "{total} bytes of property values, budget {budget}");
    let expected: Vec<&str> = case["psets"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert_eq!(sets.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), expected);
    for pin in case["psets"].as_array().unwrap() {
        let name = pin["name"].as_str().unwrap();
        let (_, values) = sets.iter().find(|(n, _)| n == name).unwrap();
        assert_eq!(values.len() as u64, pin["count"].as_u64().unwrap(), "{name}");
        match pin.get("values") {
            Some(exact) => {
                let exact: Vec<&str> = exact.as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
                assert_eq!(values.iter().map(String::as_str).collect::<Vec<_>>(), exact, "{name}");
            }
            None => {
                let joined = values.join("\n");
                let hash: String = Sha256::digest(joined.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
                let pinned = (pin["length"].as_u64().unwrap(), pin["sha256"].as_str().unwrap().to_string());
                assert_eq!((joined.len() as u64, hash), pinned, "{name}");
            }
        }
    }
}
