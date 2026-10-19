// SPDX-License-Identifier: MPL-2.0
//! Real selected occurrences keep unused diagnostic backing absent, then refuse
//! genuinely required child path backing under the captured bounded account.
use super::*;
use crate::program::{retained::RetainedContract, retained_walk::RetainedWalk};
use crate::resource::{Dimension, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
const SOURCE: &str = include_str!(
    "../../../../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc"
);

#[test]
fn retained_repeated_opening_classifier_has_no_unused_backing_before_typed_child_refusal() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = GeometryRouter::new();
    let host = decoder.decode_by_id(30).unwrap();
    // Immutable source and selected index are supplied before the bounded child
    // domain, as at the real host/context boundary. Every repeated use is real.
    decoder.decode_by_id(50).unwrap();
    let ids = vec![50; 2053];
    let walk = RetainedWalk::root(30);
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        live_bytes: Some(0),
        ..Default::default()
    }));
    account.scope(|| {
        let _walk=walk.acceptance_scope().unwrap();
        let classifier=Classifier::for_contract(host,ids,true,true);
        // Account counters alone cannot detect an unadmitted allocation. Check
        // actual Vec backing: restoring the old eager capacity fails this test.
        assert_eq!(classifier.diagnostic.capacity(),0);
        assert_eq!(classifier.ids.len(),2053);
        let mut control=OpeningControl::from_classifier(classifier);
        let OpeningPoll::Source(source)=control.poll() else {panic!("original Decode transition")};
        control.resume(source.execute(&router,&mut decoder),&router);
        let OpeningPoll::Geometry(child)=control.poll() else {panic!("original real Body child")};
        let error=match child.admit_retained(&router,RetainedContract {source_epoch:7,source_revision:11}) {
            Ok(_)=>panic!("zero bytes cannot admit child ancestry backing"),Err(error)=>error,
        };
        let crate::Error::ProgramStopped(stop)=error else {panic!("typed resource stop")};
        assert!(matches!(stop,ProgramStop::ResourceRefused(failure) if failure.dimension==Dimension::LiveBytes && failure.remaining==0));
        assert_eq!(account.check(),Err(stop));assert_eq!(account.usage().peak_live_bytes,0);
        control.resume(OpeningReply::RetainedParts(Err(stop.into())),&router);
        assert!(matches!(control.poll(),OpeningPoll::Complete(Err(crate::Error::ProgramStopped(actual))) if actual==stop));
        assert!(decoder.get_cached(46).is_none(),"refused child never reaches cutter source");
    });
}

#[test]
fn exact_classifier_preserves_original_diagnostic_capacity_before_any_source_poll() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let host = decoder.decode_by_id(30).unwrap();
    let classifier = Classifier::from_owned(host, vec![50; 2053], true);
    assert_eq!(classifier.diagnostic.capacity(), 2053);
    assert_eq!(classifier.ids.len(), 2053);
    assert!(decoder.get_cached(50).is_none());
}
