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
    let failed: Vec<String> = vector["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| std::panic::catch_unwind(|| check_exporter_budget_case(case)).is_err())
        .map(|case| case["name"].as_str().unwrap().to_string())
        .collect();
    assert!(failed.is_empty(), "cases that differ from the shared vector: {failed:?}");
}

fn check_exporter_budget_case(case: &serde_json::Value) {
    let text = format!(
        "ISO-10303-21;\nHEADER;FILE_SCHEMA(('IFC4'));ENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        expand_budget_lines(&case["dataLines"]).join("\n")
    );
    let entities = expand_budget_ids(&case["entityIds"]);
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

/// The vector's `dataLines` with each `{"repeat": [..], "from", "count"}` run
/// expanded: `{i}` in each line is `from`, `from + 1`, ... for `count` rounds.
fn expand_budget_lines(lines: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    for line in lines.as_array().unwrap() {
        if let Some(text) = line.as_str() {
            out.push(text.to_string());
            continue;
        }
        for i in expand_budget_ids(&serde_json::json!([line])) {
            for template in line["repeat"].as_array().unwrap() {
                out.push(template.as_str().unwrap().replace("{i}", &i.to_string()));
            }
        }
    }
    out
}

/// The vector's `entityIds`, each `{"from", "count"}` run expanded.
fn expand_budget_ids(ids: &serde_json::Value) -> Vec<u32> {
    let mut out = Vec::new();
    for id in ids.as_array().unwrap() {
        match id.as_u64() {
            Some(id) => out.push(id as u32),
            None => {
                let from = id["from"].as_u64().unwrap() as u32;
                out.extend(from..from + id["count"].as_u64().unwrap() as u32);
            }
        }
    }
    out
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

/// #7770: a regenerated quantity set was written from `unwrap_or(0.0)`, so an
/// overflow quantity (`1.E400`, kept as raw text by the tokenizer) or an unset
/// one came back as a fabricated `0.`. The TS `QuantityExtractor` drops a
/// quantity whose value is not a number; so does this base (D13).
#[test]
fn a_non_numeric_quantity_value_is_dropped_not_zeroed() {
    let text = "ISO-10303-21;\nHEADER;FILE_SCHEMA(('IFC4'));ENDSEC;\nDATA;\n\
#10=IFCWALL('0WallA0000000000000010A',$,'Wall',$,$,$,$,$,$);\n\
#11=IFCQUANTITYLENGTH('Over',$,$,1.E400,$);\n\
#12=IFCQUANTITYLENGTH('Unset',$,$,$,$);\n\
#13=IFCQUANTITYLENGTH('Ok',$,$,2.5,$);\n\
#14=IFCELEMENTQUANTITY('0Qto0000000000000014A',$,'Qto_Wall',$,$,(#11,#12,#13));\n\
#15=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000015A',$,$,$,(#10),#14);\n\
ENDSEC;\nEND-ISO-10303-21;\n";
    let src = Source::index(text.as_bytes());
    let mut base = BaseSets::new(&src, &HashSet::from([10]));
    let sets = base.qsets(10);
    let got: Vec<(String, f64)> = sets[0].quantities.iter().map(|q| (q.name.clone(), q.value)).collect();
    assert_eq!(got, vec![("Ok".to_string(), 2.5)]);
}
