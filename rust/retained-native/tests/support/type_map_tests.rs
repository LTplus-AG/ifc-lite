// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: type products are intentionally excluded by the whole-model contract.
use super::support::*;
#[test]
fn canonical_jobs_skip_type_products_and_empty_jobs_in_exact_order() {
    let source = ifc_lite_core::SourceBundle::new(SOURCE.as_bytes().to_vec());
    let ids: Vec<_> =
        ifc_lite_processing::element::retained_runtime::canonical_element_jobs(&source)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
    assert_eq!(ids, vec![10, 20, 50]);
}
#[test]
fn repeated_mapped_occurrences_publish_separate_placements() {
    let text = include_str!("../../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
    let Some(outcomes) = native(text) else { return };
    let products: Vec<_> = outcomes
        .iter()
        .filter_map(|o| match o {
            ifc_lite_retained_native::ProductOutcome::Published(s) => Some(s),
            _ => None,
        })
        .collect();
    assert!(products.len() >= 2, "{outcomes:?}");
    for product in &products {
        let actual = super::geometry_assertions::measured(product);
        let exact = super::geometry_assertions::exact_bounds(text, product.product_id);
        assert!(
            super::metrics::bbox_deviation(&actual.bbox, &exact) <= 1e-4,
            "actual {:?}, exact {exact:?}",
            actual.bbox
        );
    }
    assert_ne!(
        products[0].parts[0].world_from_object,
        products[1].parts[0].world_from_object
    );
}

#[test]
fn h2a2_native_cached_mapping_reuses_one_live_receipt_for_distinct_styled_occurrences() {
    let Some(worker) = worker_path() else {
        return;
    };
    let text = SOURCE.replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#93)")
        .replace("#13=IFCEXTRUDEDAREASOLID", "#13=IFCMAPPEDITEM(#81,#82);#113=IFCEXTRUDEDAREASOLID")
        .replace("ENDSEC;END-ISO", "#81=IFCREPRESENTATIONMAP(#5,#83);#82=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84,1.,$);#83=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#113));#84=IFCCARTESIANPOINT((2.,4.,6.));#93=IFCMAPPEDITEM(#81,#94);#94=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);ENDSEC;END-ISO");
    let mut outcomes = Vec::new();
    let options = ifc_lite_retained_native::ModelOptions {
        ids: Some([10].into_iter().collect()),
        ..Default::default()
    };
    let (_, timing) = ifc_lite_retained_native::run_model_native_timed(
        ifc_lite_core::SourceBundle::new(text.as_bytes().to_vec()),
        std::path::Path::new(&worker),
        &options,
        |o| outcomes.push(o),
    )
    .unwrap();
    assert_eq!(
        timing.construction_count, 1,
        "one physical source for two occurrences"
    );
    let product = shape(&outcomes, 10);
    assert_eq!(product.parts.len(), 2);
    super::geometry_assertions::assert_geometry(
        product,
        48.,
        Some(super::geometry_assertions::exact_bounds(&text, 10)),
    );
    assert_ne!(
        product.parts[0].world_from_object,
        product.parts[1].world_from_object
    );
}
