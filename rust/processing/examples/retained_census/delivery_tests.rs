// SPDX-License-Identifier: MPL-2.0
//! #7955 R3: a controller diagnostic is judged by its own inspection deadline,
//! not by how long later rows or the final census serialization take.
use super::*;
use ifc_lite_geometry::resource::inspection_test_clock;

#[test]
fn issue_7955_controller_rows_inspected_in_time_survive_later_census_delay() {
    inspection_test_clock::scope(|clock| {
        let text = super::super::tests::model("#90=IFCWALL('0000000000000000000090',$,$,$,$,$,$,$);");
        let mut fixture = super::super::census_bytes(text.as_bytes());
        // Descriptive fixture identity only, not compilation-source evidence.
        inspect_at(text.as_bytes(), &mut fixture.products, "0000000000000000000000000000000000000000");
        let mut report = super::super::census_paths(Vec::new()).unwrap();
        report.aggregate.add(&fixture.counts);
        report.present.push("inline.ifc".into());
        report.fixtures.insert("inline.ifc".into(), fixture);
        let before = serde_json::to_value(&report).unwrap();
        assert_eq!(before["fixtures"]["inline.ifc"]["products"]["13"]["controller"]["outcome"]["kind"],
            "requires_numerical_evaluation");
        // Every row finished inside its own deadline. Output delayed past the
        // per-report deadline must not turn those rows into delivery refusals.
        clock.advance(10000);
        let after = serde_json::to_value(&report).expect("delayed output must preserve complete census serialization");
        assert_eq!(after, before);
        let current = after["fixtures"]["inline.ifc"]["products"].as_object().unwrap();
        assert_eq!(current["13"]["controller"]["outcome"]["kind"], "requires_numerical_evaluation");
        assert_eq!(current["90"]["controller"]["outcome"]["kind"], "traversal_only");
        assert!(current.values().all(|product| product["controller"]["kind"] != "delivery_refused"));
    });
}

#[test]
fn issue_7955_controller_deadline_judges_each_row_inspection_only() {
    inspection_test_clock::scope(|clock| {
        let text = super::super::tests::model("#90=IFCWALL('0000000000000000000090',$,$,$,$,$,$,$);");
        let mut fixture = super::super::census_bytes(text.as_bytes());
        // The first row (#13) expires inside its own inspection; #90 starts later.
        clock.expire_at("report_write", 1, 10000);
        inspect_at(text.as_bytes(), &mut fixture.products, "0000000000000000000000000000000000000000");
        let expired = serde_json::to_value(&fixture.products[&13].controller).unwrap();
        assert_eq!(expired["code"], "DEADLINE_EXCEEDED");
        assert!(expired.get("outcome").is_none());
        let later = serde_json::to_value(&fixture.products[&90].controller).unwrap();
        assert_eq!(later["outcome"]["kind"], "traversal_only");
    });
}
