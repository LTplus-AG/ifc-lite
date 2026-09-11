// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
fn document(rows: &str) -> Vec<u8> {
    format!("ISO-10303-21;HEADER;FILE_DESCRIPTION(('Catalog'),'2;1');FILE_NAME('catalog.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;{rows}ENDSEC;END-ISO-10303-21;").into_bytes()
}
fn fixture() -> Vec<u8> {
    document("#1=IFCWALL('wall',$,'Wall',$,$,$,$,$,.NOTDEFINED.);
#2=IFCSLAB('slab',$,'Slab',$,$,$,$,$,.FLOOR.);
#3=IFCWALL('other',$,'Other wall',$,$,$,$,$,.NOTDEFINED.);
#11=IFCCARTESIANPOINT((0.,0.,0.));
#20=IFCWALLTYPE('walltype',$,'Duplicate',$,$,$,$,$,$,.NOTDEFINED.);
#21=IFCSLABTYPE('slabtype',$,'Duplicate',$,$,$,$,$,$,.FLOOR.);
#30=IFCRELDEFINESBYTYPE('rel1',$,$,$,(#1,#3),#20);
#31=IFCRELDEFINESBYTYPE('rel2',$,$,$,(#2),#21);")
}
fn request() -> AppearanceCatalogRequest {
    AppearanceCatalogRequest { schema: "IFC4".into(), source_revision: "revision".into(), product_ids: vec![3, 11, 1, 999, 2, 3] }
}
#[test]
fn issue_4243_catalogs_exact_classes_type_identity_and_explicit_ineligible_owners() {
    let catalog = catalog_appearance(&fixture(), &request()).unwrap();
    assert_eq!(catalog.products.iter().map(|p| p.product_id).collect::<Vec<_>>(), vec![1, 2, 3]);
    assert_eq!(catalog.products[0].ifc_class, "IfcWall");
    assert_eq!(catalog.products[1].ifc_class, "IfcSlab");
    assert_eq!(catalog.products[0].type_ids, vec![20]);
    assert_eq!(catalog.products[1].type_ids, vec![21]);
    assert_eq!(catalog.products[2].type_ids, vec![20]);
    assert_eq!(catalog.types.iter().map(|t| t.type_id).collect::<Vec<_>>(), vec![20, 21]);
    assert_eq!(catalog.types[0].name, catalog.types[1].name); // Labels never merge identities.
    assert_eq!(catalog.missing_product_ids, vec![11, 999]);
    let json = serde_json::to_value(catalog).unwrap();
    assert_eq!(json["types"][0]["Name"], "Duplicate");
    assert!(json["types"][0].get("name").is_none());
}
#[test]
fn issue_4243_uses_effective_snapshot_retypes_and_relation_reassignment() {
    let effective = String::from_utf8(fixture()).unwrap()
        .replace("#1=IFCWALL(", "#1=IFCSLAB(")
        .replace("(#1,#3),#20", "(#3),#20")
        .replace("(#2),#21", "(#1,#2),#21");
    let catalog = catalog_appearance(effective.as_bytes(), &request()).unwrap();
    assert_eq!(catalog.products[0].ifc_class, "IfcSlab");
    assert_eq!(catalog.products[0].type_ids, vec![21]);
    assert_eq!(catalog.products[2].type_ids, vec![20]);
}
#[test]
fn issue_4243_catalog_refuses_invalid_references_and_request_budgets_without_partial_results() {
    let invalid = String::from_utf8(fixture()).unwrap().replace("(#1,#3),#20", "(#1,#3),#11");
    assert!(catalog_appearance(invalid.as_bytes(), &request()).unwrap_err().contains("RelatingType"));
    let mut request = request(); request.product_ids = vec![1; 10_001];
    assert!(catalog_appearance(b"", &request).unwrap_err().contains("owner/revision budget"));
    request.product_ids = vec![0];
    assert!(catalog_appearance(b"", &request).unwrap_err().contains("owner/revision budget"));
    request.product_ids.clear(); request.source_revision = "x".repeat(4097);
    assert!(catalog_appearance(b"", &request).unwrap_err().contains("owner/revision budget"));
}
#[test]
fn issue_4243_catalog_bounds_type_label_and_membership_expansion() {
    let source = String::from_utf8(fixture()).unwrap().replacen("'Duplicate'", &format!("'{}'", "x".repeat(4 * 1024 * 1024 + 1)), 1);
    assert!(catalog_appearance(source.as_bytes(), &request()).unwrap_err().contains("metadata budget"));
    let mut rows = String::new();
    for id in 1..=10_000 { rows.push_str(&format!("#{id}=IFCWALL('wall',$,$,$,$,$,$,$,.NOTDEFINED.);")); }
    let members = (1..=10_000).map(|id| format!("#{id}")).collect::<Vec<_>>().join(",");
    for offset in 0..21 {
        let typ = 20_000 + offset; let relation = 30_000 + offset;
        rows.push_str(&format!("#{typ}=IFCWALLTYPE('type',$,$,$,$,$,$,$,$,.NOTDEFINED.);#{relation}=IFCRELDEFINESBYTYPE('rel',$,$,$,({members}),#{typ});"));
    }
    let mut request = request(); request.product_ids = (1..=10_000).collect();
    assert!(catalog_appearance(&document(&rows), &request).unwrap_err().contains("type memberships"));
}
