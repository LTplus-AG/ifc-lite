// SPDX-License-Identifier: MPL-2.0
//! #7955 R3: one aged controller diagnostic cannot discard the census inventory.
use super::*;
use ifc_lite_geometry::resource::inspection_test_clock;

#[test]
fn issue_7955_expired_controller_delivery_preserves_actual_census_rows_and_counts() {
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
        clock.advance(10000);
        let after = serde_json::to_value(&report).expect("expired row must preserve complete census serialization");
        assert_eq!(after["aggregate"], before["aggregate"]);
        assert_eq!(after["present"], before["present"]);
        assert_eq!(after["missing"], before["missing"]);
        let prior = before["fixtures"]["inline.ifc"].as_object().unwrap();
        let current = after["fixtures"]["inline.ifc"].as_object().unwrap();
        for (key, value) in prior {
            if key != "products" { assert_eq!(&current[key], value, "fixture inventory {key}"); }
        }
        let prior = prior["products"].as_object().unwrap();
        let current = current["products"].as_object().unwrap();
        assert_eq!(prior.keys().collect::<Vec<_>>(), current.keys().collect::<Vec<_>>());
        for (id, product) in prior {
            for (key, value) in product.as_object().unwrap() {
                if key != "controller" { assert_eq!(&current[id][key], value, "product {id}: {key}"); }
            }
        }
        assert_eq!(current["13"]["controller"], serde_json::json!({
            "kind":"delivery_refused", "code":"DEADLINE_EXCEEDED", "authority":"diagnostic_only",
        }));
        assert!(current["13"]["controller"].get("outcome").is_none());
        assert_eq!(current["90"]["controller"]["kind"], "delivery_refused");
    });
}
