// SPDX-License-Identifier: MPL-2.0
//! Canonical demand-driven control. Source admission happens only at the
//! reached continuation; no recursive boolean/CSG operand evaluation remains.
use crate::processors::boolean::{BooleanClippingProcessor, OperandPath, MAX_BOOLEAN_DEPTH,
    MAX_OPERAND_PATH_NODES, MAX_OPERAND_VISITS, boolean_operator};
use crate::{BoolFailureReason, BoolOp, Error, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
mod state;
mod batch;
mod step;
mod work;
mod operand;
mod protocol;
mod transitions;
mod reports;
pub(crate) use protocol::{BooleanProgram, BooleanPoll, BooleanTicket, BooleanSourceReply, BooleanNumericalReply, ReadyBoolean};
use state::{Frame, Steps, Value, Walk};

/// Ephemeral services borrowed only while driving a reached transition.
pub(super) struct Services<'a, 'source> {
    recorder: &'a BooleanClippingProcessor,
    decoder: &'a mut EntityDecoder<'source>,
}

/// Owned common-program child. No source service or runtime guard is retained.
pub(super) struct BooleanState {
    visited: OperandPath,
    quality: TessellationQuality,
    frames: Vec<Frame>,
    active: Vec<u32>,
    value: Option<Value>,
    reports: crate::construction::ConstructionReports,
    skip_small_cuts: bool,
    unwind_sink:Option<crate::processors::boolean::FailureSink>,
    pending_reports:Option<reports::PendingReports>,
}
impl BooleanState {
    fn new(visited: OperandPath, quality: TessellationQuality, first: Frame) -> Self {
        Self { visited, quality, frames: vec![first], active: Vec::new(), value: None, reports: Default::default(), skip_small_cuts: false, unwind_sink:None, pending_reports:None }
    }
    fn enter_path(&mut self, id: u32) -> Result<()> {
        if !self.visited.insert(id) {
            return Err(Error::geometry(format!("Cyclic boolean/CSG operand reference at #{id}")));
        }
        self.active.push(id);
        self.frames.push(Frame::ExitPath(id));
        Ok(())
    }
    fn enter_boolean(&mut self, entity: DecodedEntity, depth: u32, services: &mut Services<'_, '_>) -> Result<()> {
        self.skip_small_cuts = services.recorder.skip_small_cuts;
        if self.visited.len() >= MAX_OPERAND_PATH_NODES {
            return Err(Error::geometry(format!(
                "Boolean/CSG operand chain exceeds {MAX_OPERAND_PATH_NODES} nested nodes at #{}", entity.id)));
        }
        if !self.visited.charge() {
            services.recorder.record_failure(BoolOp::Unknown, BoolFailureReason::OperandBudgetExhausted);
            return Err(Error::geometry(format!(
                "Boolean/CSG operand walk exceeds {MAX_OPERAND_VISITS} node visits at #{}", entity.id)));
        }
        self.enter_path(entity.id)?;
        if depth > MAX_BOOLEAN_DEPTH {
            return Err(Error::geometry(format!(
                "Boolean nesting depth {depth} exceeds limit {MAX_BOOLEAN_DEPTH}")));
        }
        self.frames.push(Frame::Walk(Walk::new(entity, depth)));
        Ok(())
    }
    fn enter_csg(&mut self, entity: DecodedEntity, depth: u32, guarded: bool, services: &mut Services<'_, '_>) -> Result<()> {
        if guarded { self.enter_path(entity.id)?; }
        let root = crate::processors::csg_primitive::resolve_tree_root(&entity, services.decoder)?;
        match root.ifc_type {
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                self.frames.push(Frame::Boolean(root, depth));
            }
            // Root validation admits only these primitive constructors.
            _ => self.frames.push(Frame::Operand { entity: root, operator: BoolOp::Unknown, depth }),
        }
        Ok(())
    }
    fn operand(&mut self, entity: DecodedEntity, operator: BoolOp, depth: u32, services: &mut Services<'_, '_>) -> Result<()> {
        match entity.ifc_type {
            // CSG starts a fresh boolean depth, but retains the current path
            // and monotonic visit count. CSG membership itself is uncharged.
            IfcType::IfcCsgSolid => self.frames.push(Frame::Csg { entity, depth: 0, guarded: true }),
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                self.frames.push(Frame::Boolean(entity, depth + 1));
            }
            _ => self.admit_operand(entity, operator, services)?,
        }
        Ok(())
    }
    fn source_frame(&mut self, frame: Frame, services: &mut Services<'_, '_>) -> Result<()> {
        crate::resource::check_current()?;
        match frame {
            Frame::Boolean(entity, depth) => self.enter_boolean(entity, depth, services)?,
            #[cfg(test)]
            Frame::BeginShells { shell_kind, operand, op, outer } => self.begin_shells(shell_kind, operand, op, outer, services.recorder)?,
            Frame::Csg { entity, depth, guarded } => self.enter_csg(entity, depth, guarded, services)?,
            Frame::Operand { entity, operator, depth } => self.operand(entity, operator, depth, services)?,
            Frame::ExitPath(id) => {
                self.visited.remove(id);
                let exited = self.active.pop();
                debug_assert_eq!(exited, Some(id));
            }
            Frame::Walk(walk) => self.walk(walk)?,
            Frame::Collect(collector) => self.collect(collector, services)?,
            Frame::CollectFirst(collector) => self.collect_first(collector, services)?,
            Frame::NextFirst(walk) => self.next_first(walk, services)?,
            Frame::AfterBase(walk) => {
                let value = self.value.take().expect("base continuation result");
                #[cfg(test)]
                unwind_tests::after_base(&value);
                #[cfg(test)]
                resource_tests::after_base(&value);
                self.frames.push(Frame::Steps(walk.steps(value, false)));
            }
            Frame::AfterBatch { walk, cutters, mark } => self.finish_batch(walk, cutters, mark)?,
            Frame::Steps(steps) => self.steps(steps, services)?,
            Frame::AfterStep { steps, operator, host } => self.solid(steps, operator, host),
            Frame::PlaneSource { steps, host, operand } => self.plane_source(steps, host, operand, services)?,
            Frame::PrismSource { steps, host, operand, plane } => self.prism_source(steps, host, operand, plane, services)?,
            Frame::SingleUnits { steps, host, cutter, plane } => {
                let units = services.decoder.length_unit_scale();
                crate::resource::check_current()?;
                self.frames.push(Frame::Numerical(work::Ready::Single(work::Single {
                    host, cutter, plane, solo_step: steps.solo_step, length_unit_scale: units }),
                    work::Continuation::Single { steps, plane }));
            }
            Frame::SolidUnits { steps, mut operation } => {
                operation.plan.length_unit_scale = services.decoder.length_unit_scale();
                crate::resource::check_current()?;
                self.frames.push(Frame::Numerical(work::Ready::Solid(operation), work::Continuation::Step(steps)));
            }
            Frame::GroupSource(group) => self.group_source(group, services)?,
            Frame::GroupPrismSource { group, cutter, plane } => self.group_prism_source(group, cutter, plane, services)?,
            Frame::VoidsSource(voids) => self.voids_source(voids, services)?,
            Frame::Numerical(_, _) => unreachable!("numerical frame executed as source"),
        }
        Ok(())
    }
    fn steps(&mut self, mut steps: Steps, services: &mut Services<'_, '_>) -> Result<()> {
        let Some(node) = steps.nodes.pop() else {
            self.value = Some((steps.mesh, steps.empty_recorded));
            return Ok(());
        };
        if steps.mesh.is_empty() {
            match boolean_operator(&node) {
                Ok(BoolOp::Difference | BoolOp::Intersection) => {
                    self.frames.push(Frame::Steps(steps));
                    return Ok(());
                }
                Ok(BoolOp::Union) => {
                    services.recorder.record_empty_operand(BoolOp::Union, steps.empty_recorded);
                    steps.empty_recorded = true;
                }
                _ => {}
            }
        }
        let host = std::mem::take(&mut steps.mesh);
        self.begin_step(node, host, steps, services)?;
        Ok(())
    }
}

impl BooleanClippingProcessor {
    pub(crate) fn execute_boolean(&self, entity: &DecodedEntity,
        decoder: &mut EntityDecoder, depth: u32, quality: TessellationQuality,
        visited: &mut OperandPath) -> Result<Value> {
        run(self, decoder, visited, quality, Frame::Boolean(entity.clone(), depth))
    }
    pub(crate) fn execute_csg(&self, entity: &DecodedEntity,
        decoder: &mut EntityDecoder, depth: u32, quality: TessellationQuality,
        visited: &mut OperandPath, guarded: bool) -> Result<Value> {
        run(self, decoder, visited, quality,
            Frame::Csg { entity: entity.clone(), depth, guarded })
    }
}

fn run(recorder: &BooleanClippingProcessor, decoder: &mut EntityDecoder,
    visited: &mut OperandPath, quality: TessellationQuality, first: Frame) -> Result<Value> {
    let mut restoring = RestoringProgram {
        program: BooleanProgram::with_path(std::mem::take(visited), quality, first),
        caller: visited,
    };
    restoring.program.drain(recorder, decoder)
}

#[cfg(test)]
mod work_tests;
#[cfg(test)]
mod dispatch_tests;

/// Return the actual owned path even when numerical/source work unwinds. Normal
/// Result cleanup is performed by `BooleanProgram::run`; on panic the baseline
/// borrowed path retained both active memberships and all spent visits.
struct RestoringProgram<'a> {
    program: BooleanProgram,
    caller: &'a mut OperandPath,
}
impl Drop for RestoringProgram<'_> {
    fn drop(&mut self) {
        crate::processors::diagnostic_capture::restore(&self.program.take_reports());
        *self.caller = self.program.take_path();
    }
}

#[cfg(test)]
mod unwind_tests;

#[cfg(test)]
mod resource_tests;
