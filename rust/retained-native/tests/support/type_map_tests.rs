// SPDX-License-Identifier: MPL-2.0
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
    assert_eq!(ids, vec![10, 20]);
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
    assert_ne!(
        products[0].parts[0].world_from_object,
        products[1].parts[0].world_from_object
    );
}
