// SPDX-License-Identifier: MPL-2.0
use super::validate;
use crate::plan::test_fixtures::wall_with_own_pset;

#[test]
fn a_clean_fixture_carries_no_findings() {
    for schema in ["IFC2X3", "IFC4", "IFC4X3"] {
        let content = wall_with_own_pset(schema);
        let findings = validate(&content, schema);
        assert!(findings.is_empty(), "{schema}: {findings:?}");
    }
}

#[test]
fn a_dangling_reference_is_reported() {
    let schema = "IFC4";
    let content = String::from_utf8(wall_with_own_pset(schema))
        .unwrap()
        .replace("#20=IFCLOCALPLACEMENT($,#21);", "#20=IFCLOCALPLACEMENT($,#9999);")
        .into_bytes();
    let findings = validate(&content, schema);
    assert!(findings.iter().any(|f| f.message.contains("#9999")), "{findings:?}");
}

#[test]
fn a_duplicated_global_id_is_reported() {
    let schema = "IFC4";
    let content = String::from_utf8(wall_with_own_pset(schema))
        .unwrap()
        .replace(
            "#31=IFCPROPERTYSET('0000000000000000000031',$,'Pset_WallCommon',$,(#30));",
            "#31=IFCPROPERTYSET('0000000000000000000010',$,'Pset_WallCommon',$,(#30));",
        )
        .into_bytes();
    let findings = validate(&content, schema);
    assert!(findings.iter().any(|f| f.message.contains("duplicated")), "{findings:?}");
}

/// Fail on purpose: an attribute-count mismatch (a hand-corrupted record
/// with one slot too few) must be flagged, proving the counter is real and
/// not comparing a record to itself.
#[test]
fn a_wrong_attribute_count_is_reported() {
    let schema = "IFC4";
    let content = String::from_utf8(wall_with_own_pset(schema))
        .unwrap()
        .replace(
            "#30=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('1HR'),$);",
            "#30=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('1HR'));",
        )
        .into_bytes();
    let findings = validate(&content, schema);
    assert!(findings.iter().any(|f| f.message.contains("declares 4")), "{findings:?}");
}
