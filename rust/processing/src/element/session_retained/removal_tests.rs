// SPDX-License-Identifier: MPL-2.0
//! #7955: authentic numerical Empty plus independent source containment.
use super::*;
use super::opening_tests::with_source;
use super::opening_witness::{removal_sources, OVERLAP};
use super::tests::worker;

#[test]
fn j2_sdk_source_protected_whole_product_removal() {
    let Some(mut worker) = worker() else { return };
    for (index, source) in removal_sources().iter().enumerate() {
        with_source(source, |execution, decoder, router| {
            while let Some(issued) = execution.issue_next(decoder, router, &worker)
                .expect("J2_REMOVAL_PERMITTED") {
                let work = issued.execute(&mut worker, 0.00001, 15., MeshLimits::default()).unwrap();
                execution.accept(work, decoder, router).unwrap_or_else(|r| panic!("{}", r.reason));
            }
            let plan = execution.traversal_plan().unwrap();
            assert_eq!(plan.values.len(), if index == 2 { 2 } else { 1 });
            assert!(plan.values.iter().all(LogicalRetainedValue::is_empty), "J2_REMOVAL_PERMITTED");
            assert!(execution.has_authenticated_opening_removal(), "J2_REMOVAL_PERMITTED");
            assert!(decoder.get_cached(66).is_none(), "J2_EMPTY_LAZY");
            execution.validate_witness().unwrap();
            assert!(!router.host_consumed_by_void(30), "J2_EFFECT_ISOLATION");
            execution.cancel();
            assert!(execution.validate_witness().is_err());
            assert!(!execution.has_authenticated_opening_removal());
            assert!(!router.host_consumed_by_void(30), "J2_EFFECT_ISOLATION");
        });
    }
}

#[test]
fn j2_source_containment_is_not_aabb_or_empty_permission() {
    // Policy checks real source, independently of an SDK boolean's answer.
    for (source, contained) in [(removal_sources().remove(0), true), (OVERLAP.to_owned(), false)] {
        let bundle = ifc_lite_core::SourceBundle::new(source.as_bytes().to_vec());
        let mut decoder = bundle.decoder();
        assert_eq!(super::removal_source::covers(&mut decoder, 26, 46).unwrap(), contained,
            "J2_REMOVAL_CONTAINMENT");
    }
}
