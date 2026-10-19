// SPDX-License-Identifier: MPL-2.0
//! Owned numerical inputs and typed, consuming effect assembly. No source services.
use crate::processors::boolean::{BooleanClippingProcessor, NumericalEffects,FailureSink,
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
    #[cfg(test)]
    fn execute(self, unwind_target: &NumericalEffects) -> Completed<Self> {
        self.execute_owned(unwind_target.unwind_sink())
    }
    fn execute_owned(self,unwind_target:FailureSink)->Completed<Self>{
        // The owned sink grants diagnostic authority only; kernel calls remain
        // in their caller's existing lexical scopes.
        let effects = PendingEffects { local: NumericalEffects::default(), unwind_target };
        let value = self.evaluate(&effects.local);
        Completed { value, failures: effects.local.take_failures(), operation: std::marker::PhantomData }
    }
}

/// The numerical sink is source-free. On unwind, preserve records already
/// produced just as the original direct recorder did. Normal completion drains
/// the log into its owned receipt first, so this guard publishes nothing then.
struct PendingEffects {
    local: NumericalEffects,
    unwind_target: FailureSink,
}
impl Drop for PendingEffects {
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
        if let Err(stop) = crate::resource::check_current() {
            // A terminal preserves every reached record, including the
            // provisional source range; it is not a numerical deferral.
            let _ = self.assemble(recorder);
            return Err(stop.into());
        }
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
impl Completed<Single> {
    pub(super) fn assemble_single(self, recorder: &BooleanClippingProcessor)
        -> Result<SingleResult> {
        let value = self.assemble(recorder);
        crate::resource::check_current()?;
        Ok(value)
    }
}
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

pub(super) struct SolidCheck {
    pub plan: SolidBooleanPlan,
    pub first: Mesh,
    pub second: Mesh,
    pub loss_recorded: bool,
}
impl Execute for SolidCheck {
    type Output = Solid;
    fn evaluate(self, _: &NumericalEffects) -> Solid {
        let admission = self.plan.admit(&self.first, &self.second);
        Solid { plan: self.plan, first: self.first, second: self.second,
            loss_recorded: self.loss_recorded, admission }
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

pub(super) struct KeptSide { pub host: Mesh, pub plane: HalfSpacePlan }
impl Execute for KeptSide {
    type Output = (Mesh, bool);
    fn evaluate(self, _: &NumericalEffects) -> Self::Output {
        let kept = crate::processors::boolean::polygonal_prism::host_stays_on_kept_side(
            &self.host, self.plane.point, self.plane.normal, self.plane.agreement);
        (self.host, kept)
    }
}

/// The complete set of numerical operations admitted by Boolean control.
/// No variant contains an entity, decoder, callback or source authority.
pub(super) enum Ready {
    Retained(crate::program::retained::RetainedPlanOperation),
    Constructor(OwnedConstructor),
    Plane(Plane),
    Kept(KeptSide),
    Prism(Prism),
    Single(Single),
    Solid(Solid),
    SolidAdmission(SolidCheck),
    Group(Group),
    Shell(crate::processors::boolean::brep_voids::plan::ShellPlan),
    Voids(Voids),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind { Retained, Constructor, Plane, Kept, Prism, Single, Solid, SolidAdmission, Group, Shell, Voids }
pub(super) enum Reply {
    Retained(Result<crate::program::retained::LogicalRetainedValue>),
    Constructor(Completed<OwnedConstructor>),
    Plane(Completed<Plane>),
    Kept(Completed<KeptSide>),
    Prism(Completed<Prism>),
    Single(Completed<Single>),
    Solid(Completed<Solid>),
    SolidAdmission(Completed<SolidCheck>),
    Group(Completed<Group>),
    Shell(Completed<crate::processors::boolean::brep_voids::plan::ShellPlan>),
    Voids(Completed<Voids>),
}
impl Ready {
    pub fn kind(&self) -> Kind {
        match self { Self::Retained(_)=>Kind::Retained, Self::Constructor(_) => Kind::Constructor, Self::Plane(_) => Kind::Plane,
            Self::Kept(_) => Kind::Kept, Self::Prism(_) => Kind::Prism,
            Self::Single(_) => Kind::Single, Self::Solid(_) => Kind::Solid,
            Self::SolidAdmission(_) => Kind::SolidAdmission,
            Self::Group(_) => Kind::Group, Self::Shell(_) => Kind::Shell, Self::Voids(_) => Kind::Voids }
    }
    pub fn execute(self, target: FailureSink) -> Reply {
        match self {
            Self::Retained(_)=>Reply::Retained(Err(crate::Error::geometry("retained Boolean requires explicit runtime admission"))),
            Self::Constructor(op) => Reply::Constructor(op.execute_owned(target)),
            Self::Plane(op) => Reply::Plane(op.execute_owned(target)),
            Self::Kept(op) => Reply::Kept(op.execute_owned(target)),
            Self::Prism(op) => Reply::Prism(op.execute_owned(target)),
            Self::Single(op) => Reply::Single(op.execute_owned(target)),
            Self::Solid(op) => Reply::Solid(op.execute_owned(target)),
            Self::SolidAdmission(op) => Reply::SolidAdmission(op.execute_owned(target)),
            Self::Group(op) => Reply::Group(op.execute_owned(target)),
            Self::Shell(op) => Reply::Shell(op.execute_owned(target)),
            Self::Voids(op) => Reply::Voids(op.execute_owned(target)),
        }
    }
}
impl Reply {
    pub fn kind(&self) -> Kind {
        match self { Self::Retained(_)=>Kind::Retained, Self::Constructor(_) => Kind::Constructor, Self::Plane(_) => Kind::Plane,
            Self::Kept(_) => Kind::Kept, Self::Prism(_) => Kind::Prism,
            Self::Single(_) => Kind::Single, Self::Solid(_) => Kind::Solid,
            Self::SolidAdmission(_) => Kind::SolidAdmission,
            Self::Group(_) => Kind::Group, Self::Shell(_) => Kind::Shell, Self::Voids(_) => Kind::Voids }
    }
}
pub(super) enum Continuation {
    RetainedOperand,
    RetainedStep(super::state::Steps),
    Operand { operand: ifc_lite_core::DecodedEntity, op: BoolOp },
    Step(super::state::Steps),
    SolidAdmission(super::state::Steps),
    Kept { steps: super::state::Steps, operand: ifc_lite_core::DecodedEntity, plane: HalfSpacePlan },
    Prism { steps: super::state::Steps, plane: HalfSpacePlan },
    Single { steps: super::state::Steps, plane: HalfSpacePlan },
    GroupPrism(super::state::GroupState),
    Group { walk: super::state::Walk, mark: usize },
    Shell(super::state::VoidsState),
    Value,
}
