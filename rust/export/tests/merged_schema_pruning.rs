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
        let link = out.lines().find(|line| line.contains("=IFCRELASSIGNSTOGROUP(")).unwrap();
        assert!(link.contains(&format!(",({id}),$,")), "{}: {link}", case.name);
        assert!(stats.warnings.iter().any(|warning| warning.contains(&format!("#33 ({}) was omitted", case.omitted_type))), "{}: {:?}", case.name, stats.warnings);
    }
}
