// SPDX-License-Identifier: MPL-2.0
//! Owned numerical inputs and typed, consuming effect assembly. No source services.
use crate::processors::boolean::{BooleanClippingProcessor, NumericalEffects,
    half_space_plan::HalfSpacePlan, polygonal_prism::BoundedPrismPlan,
    single_cutter_gate::SingleCutterSubtract,
    solid_execution::{SolidAdmission, SolidBooleanPlan}};
use crate::{BoolFailure, BoolFailureReason, BoolOp, Mesh, Result};
use super::state::Value;
use crate::program::OwnedConstructor;

/// A synchronous work seam: the payload chooses its result type. Results cannot
/// be submitted to another operation or replayed; assembly consumes the receipt.
pub(super) trait Execute: Sized {
    type Output;
    fn evaluate(self, recorder: &NumericalEffects) -> Self::Output;
    fn execute(self, unwind_target: &NumericalEffects) -> Completed<Self> {
        // This owns only an initially allocation-free Vec log: no schema,
        // source dispatcher, mutable global diagnostics or census drain.
        // Kernel calls still run in the caller's existing scopes.
        let effects = PendingEffects { local: NumericalEffects::default(), unwind_target };
        let value = self.evaluate(&effects.local);
        Completed { value, failures: effects.local.take_failures(), operation: std::marker::PhantomData }
    }
}

/// The numerical sink is source-free. On unwind, preserve records already
/// produced just as the original direct recorder did. Normal completion drains
/// the log into its owned receipt first, so this guard publishes nothing then.
struct PendingEffects<'a> {
    local: NumericalEffects,
    unwind_target: &'a NumericalEffects,
}
impl Drop for PendingEffects<'_> {
    fn drop(&mut self) {
        let failures = self.local.take_failures();
        if !failures.is_empty() { self.unwind_target.absorb_failures(failures); }
    }
}

pub(super) struct Completed<P: Execute> {
    value: P::Output,
    operation: std::marker::PhantomData<fn() -> P>,
    failures: Vec<BoolFailure>,
}
impl<P: Execute> Completed<P> {
    pub(super) fn assemble(self, recorder: &BooleanClippingProcessor) -> P::Output {
        recorder.absorb_failures(self.failures);
        self.value
    }
}
impl Completed<Group> {
    pub(super) fn assemble_group(self, recorder: &BooleanClippingProcessor,
        mark: usize) -> Result<Option<Value>> {
        // Only a historical deferred group rewinds the provisional bool log.
        // Source reports, entered paths and the work counter are not effects
        // of this numerical request and cannot be refunded here.
        if matches!(&self.value, Ok(None)) { recorder.rewind_to(mark); }
        self.assemble(recorder)
    }
}
impl Execute for OwnedConstructor {
    type Output = Result<Mesh>;
    fn evaluate(self, _: &NumericalEffects) -> Self::Output { self.evaluate() }
}

pub(super) struct Plane {
    pub host: Mesh,
    pub plane: HalfSpacePlan,
    pub fallback: bool,
}
impl Execute for Plane {
    type Output = Result<Value>;
    fn evaluate(self, recorder: &NumericalEffects) -> Self::Output {
        if self.fallback {
            recorder.record_failure(BoolOp::Difference,
                BoolFailureReason::PolygonalBoundedHalfSpaceFallback);
        }
        let clipped = self.plane.clip(&self.host)?;
        Ok((recorder.guard_against_full_host_removal(self.host, clipped,
            self.plane.point, self.plane.normal), false))
    }
}

pub(super) struct Prism {
    pub plan: BoundedPrismPlan,
    pub host: Mesh,
    pub plane: HalfSpacePlan,
}
impl Execute for Prism {
    // Retain the host even on a prism refusal, for the original plane fallback.
    type Output = (Mesh, Result<Mesh>);
    fn evaluate(self, _: &NumericalEffects) -> Self::Output {
        let result = self.plan.evaluate(&self.host, self.plane.components());
        (self.host, result)
    }
}

pub(super) struct Single {
    pub host: Mesh,
    pub cutter: Mesh,
    pub plane: HalfSpacePlan,
    pub solo_step: bool,
    pub length_unit_scale: f64,
}
pub(super) enum SingleResult { Done(Value), Fallback(Mesh) }
impl Execute for Single {
    type Output = SingleResult;
    fn evaluate(self, recorder: &NumericalEffects) -> Self::Output {
        match recorder.resolve_single_cutter_subtract(&self.host, &self.cutter,
            self.solo_step, self.length_unit_scale) {
            SingleCutterSubtract::Clipped(clipped) => SingleResult::Done((
                recorder.guard_against_full_host_removal(self.host, clipped,
                    self.plane.point, self.plane.normal), false)),
            SingleCutterSubtract::KeepUncut => SingleResult::Done((self.host, false)),
            SingleCutterSubtract::FallThrough => SingleResult::Fallback(self.host),
        }
    }
}

pub(super) struct Solid {
    pub plan: SolidBooleanPlan,
    pub admission: SolidAdmission,
    pub first: Mesh,
    pub second: Mesh,
    pub loss_recorded: bool,
}
impl Execute for Solid {
    type Output = Result<Value>;
    fn evaluate(self, recorder: &NumericalEffects) -> Self::Output {
        self.plan.evaluate_admitted(recorder, self.first, self.second,
            self.loss_recorded, self.admission)
    }
}

pub(super) struct Group {
    pub base: Mesh,
    pub prisms: Vec<Mesh>,
    pub length_unit_scale: f64,
}
impl Execute for Group {
    type Output = Result<Option<Value>>;
    fn evaluate(self, recorder: &NumericalEffects) -> Self::Output {
        recorder.evaluate_polygonal_group(self.base, self.prisms, self.length_unit_scale, 0)
    }
}

impl Execute for crate::processors::boolean::brep_voids::plan::ShellPlan {
    type Output = Result<Mesh>;
    fn evaluate(self, _: &NumericalEffects) -> Self::Output { self.evaluate() }
}

pub(super) struct Voids {
    pub ready: crate::processors::boolean::brep_voids::void_evaluation::ReadyVoids,
    pub outer: Mesh,
    pub length_unit_scale: f64,
    pub op: BoolOp,
    pub operand_type: ifc_lite_core::IfcType,
}
impl Execute for Voids {
    type Output = Value;
    fn evaluate(self, recorder: &NumericalEffects) -> Self::Output {
        self.ready.subtract(self.outer, self.length_unit_scale, recorder, self.op, &self.operand_type)
    }
}
