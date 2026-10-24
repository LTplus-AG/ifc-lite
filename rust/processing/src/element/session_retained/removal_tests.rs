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

#[test]
fn j2_sdk_removal_rejects_foreign_relationship_authority() {
    let Some(mut worker) = worker() else { return };
    let source = removal_sources().remove(0).replace("$,$,$,#30,#50)", "$,$,$,#31,#50)");
    super::opening_tests::with_selected_voids(&source, true, |execution, decoder, router| {
        let error = loop {
            match execution.issue_next(decoder, router, &worker) {
                Err(error) => break error,
                Ok(None) => panic!("J2_REMOVAL_RELATION_AUTHORITY"),
                Ok(Some(issued)) => {
                    let work = issued.execute(&mut worker, 0.00001, 15., MeshLimits::default()).unwrap();
                    execution.accept(work, decoder, router).unwrap_or_else(|r| panic!("{}", r.reason));
                }
            }
        };
        assert!(matches!(error, RetainedExecutionError::Source), "J2_REMOVAL_RELATION_AUTHORITY: {error}");
        assert!(execution.traversal_plan().is_none());
        assert!(!execution.has_authenticated_opening_removal());
        assert!(execution.issue_next(decoder, router, &worker).is_err());
        assert!(!router.host_consumed_by_void(30), "J2_EFFECT_ISOLATION");
    });
}

#[test]
fn j2_sdk_removal_seal_rejects_foreign_terminal_slot() {
    let Some(mut worker) = worker() else { return };
    with_source(&removal_sources().remove(0), |execution, decoder, router| {
        while let Some(issued) = execution.issue_next(decoder, router, &worker).unwrap() {
            let work = issued.execute(&mut worker, 0.00001, 15., MeshLimits::default()).unwrap();
            execution.accept(work, decoder, router).unwrap_or_else(|r| panic!("{}", r.reason));
        }
        assert!(execution.has_authenticated_opening_removal());
        // A terminal definition from the same live ledger is not interchangeable
        // with the sealed product slot, even though all worker handles are live.
        let original = execution.plan.as_mut().unwrap().values[0].try_copy().unwrap();
        execution.plan.as_mut().unwrap().values[0] = execution.ledger[0].0.try_copy().unwrap();
        assert!(execution.validate_witness().is_err(), "J2_REMOVAL_TERMINAL_SLOT");
        execution.plan.as_mut().unwrap().values[0] = original;
        execution.validate_witness().unwrap();
        assert!(!router.host_consumed_by_void(30));
    });
}

#[test]
fn j2_sdk_empty_with_unqualified_source_policy_is_terminal_refusal() {
    let Some(mut worker) = worker() else { return };
    // Same real cutter geometry, valid IFC direction ratios, outside the
    // deliberately narrow raw-direction proof domain. Empty alone is insufficient.
    let source = removal_sources().remove(0).replace("#40= IFCDIRECTION((1.,0.));", "#40= IFCDIRECTION((2.,0.));");
    with_source(&source, |execution, decoder, router| {
        let mut empty_cut = false;
        let error = loop {
            match execution.issue_next(decoder, router, &worker) {
                Err(error) => break error,
                Ok(None) => panic!("J2_REMOVAL_UNKNOWN_POLICY"),
                Ok(Some(issued)) => {
                    let work = issued.execute(&mut worker, 0.00001, 15., MeshLimits::default()).unwrap();
                    empty_cut |= work.realizations.iter().any(|receipt| receipt.is_empty());
                    execution.accept(work, decoder, router).unwrap_or_else(|r| panic!("{}", r.reason));
                }
            }
        };
        assert!(empty_cut);
        assert!(matches!(error, RetainedExecutionError::Unsupported(message) if message.contains("protection policy")),
            "J2_REMOVAL_UNKNOWN_POLICY");
        assert!(execution.traversal_plan().is_none());
        assert!(!execution.has_authenticated_opening_removal());
        assert!(!router.host_consumed_by_void(30), "J2_EFFECT_ISOLATION");
    });
}
