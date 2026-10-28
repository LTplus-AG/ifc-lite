// SPDX-License-Identifier: MPL-2.0
//! #7781: body-only and opening-source admission intentionally differ.
use super::*;
use crate::profile_walk_model as model;

#[test]
fn issue_7781_body_and_opening_selection_keep_malformed_and_duplicate_policies() {
    let router = GeometryRouter::new();
    for (kind, product, body, opening) in [
        ("'SweptSolid'", "IFCWALL", true, true),
        ("$", "IFCWALL", false, true),
        ("'Annotation2D'", "IFCANNOTATION", false, true),
        ("'Curve2D'", "IFCWALL", false, false),
    ] {
        let content = model::wall("#160", &format!("#160=IFCSHAPEREPRESENTATION(#13,$,{kind},(#140));"))
            .replace("#100=IFCWALL", &format!("#100={product}"));
        let mut decoder = EntityDecoder::new(&content);
        let element = decoder.decode_by_id(100).unwrap();
        assert_eq!(
            router.body_representation_items(&element, &mut decoder).is_some(),
            body,
            "{kind}"
        );
        assert_eq!(
            !router
                .opening_probe_source(&element, &mut decoder)
                .unwrap()
                .0
                .is_empty(),
            opening,
            "{kind}"
        );
    }
    let content = model::chain(1).replace("(#160)", "(#160,#161)")
        + "\n#161=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140));";
    for malformed in [false, true] {
        let source = if malformed {
            content.replace("#151=IFCPRODUCTDEFINITIONSHAPE", "#151=IFCPRODUCTREPRESENTATION")
        } else {
            content.clone()
        };
        let mut decoder = EntityDecoder::new(&source);
        let element = decoder.decode_by_id(100).unwrap();
        let body = router.body_representation_items(&element, &mut decoder);
        if malformed {
            assert!(body.is_none());
        } else {
            assert_eq!(body.unwrap().iter().map(|e| e.id).collect::<Vec<_>>(), [140]);
        }
        assert_eq!(
            router
                .opening_probe_source(&element, &mut decoder)
                .unwrap()
                .0
                .iter()
                .map(|e| e.id)
                .collect::<Vec<_>>(),
            [140]
        );
    }
}

#[test]
fn issue_7781_items_fault_skips_representation_and_preserves_error_text() {
    let content = model::wall(
        "#160,#161,#162",
        "\
        #160=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',17);\n\
        #161=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid');\n\
        #162=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140));",
    );
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(&content);
    let element = decoder.decode_by_id(100).unwrap();
    assert_eq!(
        router.body_representation_items(&element, &mut decoder).unwrap().len(),
        1
    );
    assert_eq!(
        router.opening_probe_source(&element, &mut decoder).unwrap().0[0].id,
        140
    );
    for (source, message) in [
        ("#100=IFCWALL();", "Element has no representation attribute"),
        (
            "#100=IFCWALL($,$,$,$,$,$,#151);#151=IFCPRODUCTDEFINITIONSHAPE();",
            "ProductDefinitionShape missing Representations",
        ),
        ("#100=IFCWALL($,$,$,$,$,$,17);", "Failed to resolve representation"),
    ] {
        let mut decoder = EntityDecoder::new(source);
        let element = decoder.decode_by_id(100).unwrap();
        assert!(matches!(router.opening_probe_source(&element, &mut decoder),
            Err(Error::GeometryError(actual)) if actual == message));
    }
}

#[test]
fn issue_7781_direction_and_opening_placement_propagate_typed_stop() {
    use crate::resource::{Cost, ExecutionAccount, ExecutionPolicy, ResourceLimits};
    let content = model::chain(1);
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(&content);
    let item = decoder.decode_by_id(1000).unwrap();
    let element = decoder.decode_by_id(100).unwrap();
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let stop = account
        .prepare(Cost {
            work: u64::MAX,
            ..Cost::default()
        })
        .unwrap_err();
    account.scope(|| {
        assert!(
            matches!(router.extract_extrusion_direction_recursive(&item, &mut decoder),
            Err(Error::ProgramStopped(actual)) if actual == stop)
        );
        assert!(matches!(router.opening_probe_source(&element, &mut decoder),
            Err(Error::ProgramStopped(actual)) if actual == stop));
    });
}
