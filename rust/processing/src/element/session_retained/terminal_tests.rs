// SPDX-License-Identifier: MPL-2.0
//! #7955 terminal removal must commit once, never at provisional proof.
use super::*;
pub(super) fn complete(execution: &mut RetainedProductExecution, decoder: &mut EntityDecoder,
    router: &GeometryRouter, worker: &mut SmlibWorker) {
    while let Some(issued) = execution.issue_next(decoder,router,worker).unwrap() {
        let work = issued.execute(worker,0.00001,15.,MeshLimits::default()).unwrap();
        execution.accept(work,decoder,router).unwrap_or_else(|r|panic!("{}",r.reason));
    }
}
#[test]
fn j2_terminal_removal_commits_once() {
    let Some(mut worker) = super::tests::worker() else { return };
    for source in super::opening_witness::removal_sources() {
        super::opening_tests::with_source(&source, |execution,decoder,router| {
            complete(execution,decoder,router,&mut worker);
            assert!(!router.host_consumed_by_void(30));
            let result = execution.publish_removed(decoder,router,&worker).expect("J2_TERMINAL_COMMIT");
            assert_eq!(result.product_id(),30);
            assert!(decoder.get_cached(66).is_none(),"J2_TERMINAL_LAZY");
            assert!(router.host_consumed_by_void(30),"J2_TERMINAL_EFFECT");
            let output = result.into_output();
            assert!(output.meshes.is_empty() && output.instance_occurrences.is_empty());
            assert!(execution.publish_removed(decoder,router,&worker).is_err(),"J2_TERMINAL_REPLAY");
        });
    }
}
#[test]
fn j2_terminal_rejects_cancel_foreign_owner_and_worker() {
    let Some(mut worker) = super::tests::worker() else { return };
    for mode in 0..4 {
        super::opening_tests::with_source(&super::opening_witness::removal_sources().remove(0), |execution,decoder,router| {
            complete(execution,decoder,router,&mut worker);
            let result = match mode {
                0 => { execution.cancel(); execution.publish_removed(decoder,router,&worker) },
                1 => { let foreign = GeometryRouter::new(); execution.publish_removed(decoder,&foreign,&worker) },
                2 => { let Some(foreign) = super::tests::worker() else { panic!("required second worker") };
                    execution.publish_removed(decoder,router,&foreign) },
                _ => { let bundle = ifc_lite_core::SourceBundle::new(super::opening_witness::removal_sources().remove(0).into_bytes());
                    execution.publish_removed(&mut bundle.decoder(),router,&worker) },
            };
            assert!(result.is_err(),"J2_TERMINAL_AUTHORITY");
            assert!(!router.host_consumed_by_void(30),"J2_TERMINAL_ISOLATION");
        });
    }
}
#[test]
fn j2_terminal_source_obligations_are_not_cleared_by_empty() {
    let Some(mut worker) = super::tests::worker() else { return };
    for record in ["#900=IFCSTYLEDITEM(#26,(#999),$);", "#900=IFCMATERIALLAYER($,-1.,$,$,$,$,$);",
        "#900=IFCSTYLEDITEM(#26,(#999),$)BOGUS();"] {
        let source = super::opening_witness::removal_sources().remove(0)
            .replace("ENDSEC;\nEND-ISO-10303-21;", &format!("{record}\nENDSEC;END-ISO-10303-21;"));
        super::opening_tests::with_source(&source, |execution,decoder,router| {
            complete(execution,decoder,router,&mut worker);
            assert!(execution.publish_removed(decoder,router,&worker).is_err(),"J2_TERMINAL_SOURCE");
            assert!(!router.host_consumed_by_void(30),"J2_TERMINAL_ISOLATION");
        });
    }
}

#[test]
fn j2_terminal_nonempty_product_keeps_final_gates() {
    let Some(mut worker) = super::tests::worker() else { return };
    super::opening_tests::with_source(super::opening_witness::OVERLAP, |execution,decoder,router| {
        complete(execution,decoder,router,&mut worker);
        assert!(!execution.has_authenticated_opening_removal());
        assert!(execution.publish_removed(decoder,router,&worker).is_err(),"J2_TERMINAL_NONEMPTY");
        assert!(!router.host_consumed_by_void(30));
    });
}
