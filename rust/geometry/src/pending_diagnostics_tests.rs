// SPDX-License-Identifier: MPL-2.0
//! Real refusal/cap emitters run under nested ownership and unwind boundaries.
use super::*;
use crate::{BoolFailureReason, BoolOp, GeometryProcessor, TessellationQuality};
use ifc_lite_core::{EntityDecoder, IfcSchema, IfcType};
use std::panic::{catch_unwind, AssertUnwindSafe};

fn refuse_face() {
    let source = "#1=IFCADVANCEDBREP(#2);#2=IFCCLOSEDSHELL((#999));";
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(1).unwrap();
    let mesh = crate::processors::AdvancedBrepProcessor::new()
        .process(
            &entity,
            &mut decoder,
            &IfcSchema::new(),
            TessellationQuality::Medium,
        )
        .unwrap();
    assert!(mesh.is_empty());
}
fn cap_curve() {
    let source = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((1.,0.,0.));
#3=IFCVERTEXPOINT(#1);#4=IFCVERTEXPOINT(#2);
#5=IFCBSPLINECURVEWITHKNOTS(1000000,(#1,#2),.UNSPECIFIED.,.F.,.F.,(2,2),(0.,1.),.UNSPECIFIED.);
#6=IFCEDGECURVE(#3,#4,#5,.T.);";
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(6).unwrap();
    let _result = crate::processors::IfcEdgeProcessor::new().process(
        &entity,
        &mut decoder,
        &IfcSchema::new(),
        TessellationQuality::Medium,
    );
}
fn mapped(label: &str) -> BoolFailure {
    BoolFailure::new(
        BoolOp::Difference,
        BoolFailureReason::UnsupportedOperand(label.into()),
    )
}
fn emit_mapped(label: &str) {
    // This legacy channel currently has no production writer. Exercise its
    // actual TLS/drain using a test-only write rather than add a public producer.
    PENDING_MAPPED_BOOL_FAILURES.with(|pending| pending.borrow_mut().push(mapped(label)));
}
fn clear() {
    let _ = Pending::take_current();
}

#[test]
fn real_owner_refusals_and_caps_do_not_steal_or_leak_ambient_reports() {
    clear();
    emit_mapped("ambient");
    let mut owner = PendingDiagnosticState::new();
    owner.with_scope(|| {
        refuse_face();
        cap_curve();
        emit_mapped("work");
    });
    let caller = Pending::take_current();
    assert_eq!(caller.mapped, [mapped("ambient")]);
    assert!(caller.source.face_refused.is_empty());
    assert!(!caller.source.curve_capped);
    owner.with_scope(|| {
        assert_eq!(
            crate::processors::take_face_refused(),
            [IfcType::IfcAdvancedFace]
        );
        assert!(crate::processors::take_curve_capped());
        assert_eq!(take_pending_mapped_bool_failures(), [mapped("work")]);
    });
    owner.publish_pending();
    let terminal = Pending::take_current();
    assert!(terminal.mapped.is_empty() && terminal.source.face_refused.is_empty());
    assert!(
        !terminal.source.curve_capped,
        "ordinary drains consume owner reports once"
    );
}

#[test]
fn error_and_panic_retain_work_evidence_and_restore_the_callers_reports() {
    for panic in [false, true] {
        clear();
        refuse_face();
        emit_mapped("ambient");
        let mut owner = PendingDiagnosticState::new();
        let result = catch_unwind(AssertUnwindSafe(|| {
            owner.with_scope(|| {
                cap_curve();
                emit_mapped("work");
                if panic {
                    panic!("controlled work failure");
                }
                Err::<(), _>("controlled admission error")
            })
        }));
        assert_eq!(result.is_err(), panic);
        if let Ok(error) = result {
            assert_eq!(error, Err("controlled admission error"));
        }
        let caller = Pending::take_current();
        assert_eq!(caller.source.face_refused, [IfcType::IfcAdvancedFace]);
        assert!(!caller.source.curve_capped);
        assert_eq!(caller.mapped, [mapped("ambient")]);
        owner.publish_pending();
        let failed = Pending::take_current();
        assert!(failed.source.curve_capped);
        assert!(failed.source.face_refused.is_empty());
        assert_eq!(failed.mapped, [mapped("work")]);
    }
}

#[test]
fn nested_independent_owners_restore_each_others_pending_streams() {
    clear();
    let mut outer = PendingDiagnosticState::new();
    let mut inner = PendingDiagnosticState::new();
    outer.with_scope(|| {
        refuse_face();
        emit_mapped("outer");
        inner.with_scope(|| {
            cap_curve();
            emit_mapped("inner");
            assert!(crate::processors::take_face_refused().is_empty());
        });
        assert!(!crate::processors::take_curve_capped());
        assert_eq!(take_pending_mapped_bool_failures(), [mapped("outer")]);
    });
    outer.publish_pending();
    assert_eq!(
        crate::processors::take_face_refused(),
        [IfcType::IfcAdvancedFace]
    );
    inner.publish_pending();
    assert!(crate::processors::take_curve_capped());
    assert_eq!(take_pending_mapped_bool_failures(), [mapped("inner")]);
}

#[test]
fn admission_adopts_only_mapped_records_and_terminal_publication_preserves_prefixes() {
    clear();
    refuse_face();
    emit_mapped("older");
    let mut owner = PendingDiagnosticState::new();
    owner.adopt_current_mapped();
    assert_eq!(
        crate::processors::take_face_refused(),
        [IfcType::IfcAdvancedFace]
    );
    assert!(take_pending_mapped_bool_failures().is_empty());
    owner.with_scope(|| {
        emit_mapped("later");
    });
    emit_mapped("caller");
    owner.publish_pending();
    assert_eq!(
        take_pending_mapped_bool_failures(),
        [mapped("caller"), mapped("older"), mapped("later")]
    );
    owner.publish_pending();
    assert!(take_pending_mapped_bool_failures().is_empty());
}

#[test]
fn retained_pending_owner_moves_workers_without_moving_active_tls_guards() {
    clear();
    let mut owner = PendingDiagnosticState::new();
    owner.with_scope(|| {
        refuse_face();
        emit_mapped("moved");
    });
    std::thread::spawn(move || {
        clear();
        cap_curve();
        emit_mapped("worker");
        owner.with_scope(|| {
            assert_eq!(
                crate::processors::take_face_refused(),
                [IfcType::IfcAdvancedFace]
            );
            assert!(!crate::processors::take_curve_capped());
            assert_eq!(take_pending_mapped_bool_failures(), [mapped("moved")]);
        });
        assert!(crate::processors::take_curve_capped());
        assert_eq!(take_pending_mapped_bool_failures(), [mapped("worker")]);
    })
    .join()
    .unwrap();
    let original = Pending::take_current();
    assert!(!original.source.curve_capped && original.source.face_refused.is_empty());
    assert!(original.mapped.is_empty());
}
