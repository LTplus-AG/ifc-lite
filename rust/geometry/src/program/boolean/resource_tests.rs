// SPDX-License-Identifier: MPL-2.0
//! Resource integration invariants use actual geometry before a reached stop.
use super::*;
use crate::kernel::mesh_volume::mesh_volume;
use crate::resource::{ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
use std::cell::Cell;

thread_local! {
    static STOP_AFTER_BASE: Cell<bool> = const { Cell::new(false) };
}
pub(super) fn after_base(value: &Value) {
    if STOP_AFTER_BASE.with(|armed| armed.replace(false)) {
        assert!((mesh_volume(&value.0).abs() - 8.).abs() < 1e-6);
        crate::resource::stop(ProgramStop::Cancelled);
    }
}
struct StopAfterBase;
impl StopAfterBase {
    fn arm() -> Self {
        STOP_AFTER_BASE.with(|armed| assert!(!armed.replace(true)));
        Self
    }
}
impl Drop for StopAfterBase {
    fn drop(&mut self) { STOP_AFTER_BASE.with(|armed| armed.set(false)); }
}

#[test]
fn stop_after_real_base_preserves_prior_records_and_skips_rhs_and_recovery() {
    let mut decoder = EntityDecoder::new("#1=IFCBLOCK($,2.,2.,2.);
#2=IFCBLOCK($,1.E400,2.,2.);#3=IFCBOOLEANRESULT(.UNION.,#1,#2);")
        .with_strict_reals();
    let root = decoder.decode_by_id(3).unwrap();
    let recorder = BooleanClippingProcessor::new();
    recorder.record_failure(BoolOp::Unknown, BoolFailureReason::EmptyOperand);
    let prior = recorder.failure_mark();
    let mut path = OperandPath::default();
    assert!(path.insert(900));
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let injection = StopAfterBase::arm();
    let result = account.scope(|| recorder.execute_boolean(&root, &mut decoder, 0,
        TessellationQuality::Medium, &mut path));
    drop(injection);
    assert!(matches!(result, Err(Error::ProgramStopped(ProgramStop::Cancelled))));
    assert_eq!(recorder.failure_mark(), prior, "a terminal is not a deferred group");
    assert!(decoder.refused_record_ids().is_empty(), "unused malformed RHS stays unread");
    assert_eq!(path.len(), 1, "returned stop exits child memberships");
    assert!(!path.insert(900), "caller ancestor survives stop");
    for _ in 1..MAX_OPERAND_VISITS { assert!(path.charge()); }
    assert!(!path.charge(), "the entered root visit remains spent");
    assert!(decoder.decode_by_id(2).is_err());
    assert!(decoder.refused_record_ids().contains(&2), "the dormant RHS is actually invalid");
}

#[test]
fn pre_stopped_void_shell_child_cannot_decode_shell_or_replace_stop_with_source_loss() {
    let mut decoder = EntityDecoder::new("#1=IFCBLOCK($,2.,2.,2.);
#91=IFCFACETEDBREPWITHVOIDS($,(#200));
#200=IFCCLOSEDSHELL((#201));#201=IFCFACE((#202));
#202=IFCFACEOUTERBOUND(#203,.T.);#203=IFCPOLYLOOP((#204));
#204=IFCCARTESIANPOINT((1.E400,0.,0.));")
        .with_strict_reals();
    let operand = decoder.decode_by_id(91).unwrap();
    let block = decoder.decode_by_id(1).unwrap();
    let outer = crate::processors::BlockProcessor::new().lower(&block, &mut decoder)
        .unwrap().evaluate();
    assert!((mesh_volume(&outer).abs() - 8.).abs() < 1e-6);
    let recorder = BooleanClippingProcessor::new();
    recorder.record_failure(BoolOp::Unknown, BoolFailureReason::EmptyOperand);
    let cached = decoder.cache_size();
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    account.cancel();
    let result = account.scope(|| operand::without_voids(&recorder, IfcType::IfcFacetedBrep,
        BoolOp::Difference, &operand, outer, &mut decoder,
        TessellationQuality::Medium));
    assert!(matches!(result, Err(Error::ProgramStopped(ProgramStop::Cancelled))));
    assert_eq!(decoder.cache_size(), cached, "no shell source work after stop");
    assert_eq!(recorder.failure_mark(), 1, "no fabricated shell-source loss");
    assert!(decoder.refused_record_ids().is_empty());
}
