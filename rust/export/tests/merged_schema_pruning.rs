// SPDX-License-Identifier: MPL-2.0

use ifc_lite_export::{MergedOptions, UnitReconciliation, export_merged_with_stats};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    target: String,
    later_schema: String,
    first: String,
    later: String,
    kept_type: String,
    omitted_type: String,
}

fn step(schema: &str, data: &str) -> String {
    format!("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('{}'));\nENDSEC;\nDATA;\n#30=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'Shared',$,$,$,$,$,$);\n{}\nENDSEC;\nEND-ISO-10303-21;\n", schema, data)
}

#[test]
fn later_same_project_guids_survive_schema_pruning_11129() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("fixtures/schema_merge_pruned_guids.json")).unwrap();
    for case in cases {
        let first = step("IFC2X3", &case.first);
        let later = step(&case.later_schema, &format!("{}\n#34=IFCGROUP('2YvctVUKr0kugbFTf53O9L',$,'Group',$,$);\n#35=IFCRELASSIGNSTOGROUP('3YvctVUKr0kugbFTf53O9L',$,$,$,(#33),$,#34);", case.later));
        let options = MergedOptions { schema: Some(case.target), unit_reconciliation: UnitReconciliation::AssumeShared, ..Default::default() };
        let (out, stats) = export_merged_with_stats(&[first.as_bytes(), later.as_bytes()], &options);
        let survivor = format!("={}('1YvctVUKr0kugbFTf53O9L',$,'Kept'", case.kept_type);
        let survivors: Vec<&str> = out.lines().filter(|line| line.contains(&survivor)).collect();
        assert_eq!(survivors.len(), 1, "{}: {out}", case.name);
        let id = survivors[0].split_once('=').unwrap().0;
        if case.kept_type == "IFCGRID" {
            let child = out.lines().find(|line| line.contains("=IFCBUILDINGELEMENTPROXY('0YvctVUKr0kugbFTf53O9M'")).unwrap().split_once('=').unwrap().0;
            assert!(out.contains(&format!("=IFCRELAGGREGATES('3YvctVUKr0kugbFTf53O9M',$,$,$,{id},({child}));")), "{out}");
        }
        let link = out.lines().find(|line| line.contains("=IFCRELASSIGNSTOGROUP(")).unwrap();
        assert!(link.contains(&format!(",({id}),$,")), "{}: {link}", case.name);
        assert!(stats.warnings.iter().any(|warning| warning.contains(&format!("#33 ({}) was omitted", case.omitted_type))), "{}: {:?}", case.name, stats.warnings);
    }
}

/// A relationship whose only member is omitted can still be kept by a later model's fold, so its GlobalId stays
/// reserved and no later record ships it twice. Twin of the TypeScript test of the same case.
#[test]
fn a_folded_relationship_keeps_a_unique_global_id_11129() {
    #[derive(serde::Deserialize)]
    struct Fold { first: String, later: String }
    let fold: Fold = serde_json::from_str(include_str!("fixtures/schema_merge_fold_guid.json")).unwrap();
    let (first, later) = (step("IFC2X3", &fold.first), step("IFC2X3", &fold.later));
    let options = MergedOptions { schema: Some("IFC4".into()), unit_reconciliation: UnitReconciliation::AssumeShared, ..Default::default() };
    let (out, _) = export_merged_with_stats(&[first.as_bytes(), later.as_bytes()], &options);
    let mut seen = std::collections::HashSet::new();
    let duplicates: Vec<&str> = out.lines().filter_map(|line| line.split_once("('").and_then(|(_, rest)| rest.get(..22)))
        .filter(|guid| guid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$') && !seen.insert(*guid)).collect();
    assert!(duplicates.is_empty(), "{duplicates:?}\n{out}");
    assert!(out.contains("=IFCRELDEFINESBYTYPE('5YvctVUKr0kugbFTf53O9L',$,'Pruned, then folded',"), "{out}");
}
