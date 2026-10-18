// SPDX-License-Identifier: MPL-2.0
//! Canonical demand-driven control. Source admission happens only at the
//! reached continuation; no recursive boolean/CSG operand evaluation remains.
use crate::processors::boolean::{BooleanClippingProcessor, OperandPath, MAX_BOOLEAN_DEPTH,
    MAX_OPERAND_PATH_NODES, MAX_OPERAND_VISITS, boolean_operator};
use step::StepAdmission;
use crate::{BoolFailureReason, BoolOp, Error, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
mod state;
mod batch;
mod step;
mod work;
mod operand;
use state::{Frame, Steps, Value, Walk};

/// Ephemeral services borrowed only while driving a reached transition.
struct Services<'a, 'source> {
    recorder: &'a BooleanClippingProcessor,
    decoder: &'a mut EntityDecoder<'source>,
}

/// Owned common-program child. No source service or runtime guard is retained.
struct BooleanProgram {
    visited: OperandPath,
    quality: TessellationQuality,
    frames: Vec<Frame>,
    active: Vec<u32>,
    value: Option<Value>,
}
impl BooleanProgram {
    fn new(visited: OperandPath, quality: TessellationQuality, first: Frame) -> Self {
        Self { visited, quality, frames: vec![first], active: Vec::new(), value: None }
    }
    fn run(&mut self, services: &mut Services<'_, '_>) -> Result<Value> {
        let result = self.drive(services);
        // Error skips queued exits. Release our admissions, preserving ancestors
        // and the monotonic budget supplied by the enclosing caller.
        for id in self.active.drain(..) { self.visited.remove(id); }
        result
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
            _ => self.value = Some(operand::evaluate(services.recorder, BoolOp::Unknown, &root, services.decoder, self.quality)?),
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
            _ => self.value = Some(operand::evaluate(services.recorder, operator, &entity, services.decoder, self.quality)?),
        }
        Ok(())
    }
    fn drive(&mut self, services: &mut Services<'_, '_>) -> Result<Value> {
        while let Some(frame) = self.frames.pop() {
            match frame {
                Frame::Boolean(entity, depth) => self.enter_boolean(entity, depth, services)?,
                Frame::Csg { entity, depth, guarded } => self.enter_csg(entity, depth, guarded, services)?,
                Frame::Operand { entity, operator, depth } => self.operand(entity, operator, depth, services)?,
                Frame::ExitPath(id) => {
                    self.visited.remove(id);
                    let exited = self.active.pop();
                    debug_assert_eq!(exited, Some(id));
                }
                Frame::Walk(walk) => self.walk(walk, services)?,
                Frame::AfterBase(walk) => {
                    let value = self.value.take().expect("base continuation result");
                    #[cfg(test)]
                    unwind_tests::after_base(&value);
                    self.frames.push(Frame::Steps(walk.steps(value, false)));
                }
                Frame::AfterBatch { walk, cutters, mark } => self.finish_batch(walk, cutters, mark, services)?,
                Frame::Steps(steps) => self.steps(steps, services)?,
                Frame::AfterStep { mut steps, operator, host } => {
                    let second = self.value.take().expect("operand continuation result");
                    let result = services.recorder.finish_solid_step(
                        operator, host, second, services.decoder, self.quality)?;
                    steps.accept(result);
                    self.frames.push(Frame::Steps(steps));
                }
            }
        }
        Ok(self.value.take().expect("completed operation result"))
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
        match services.recorder.begin_boolean_step(
            &node, host, services.decoder, self.quality, steps.solo_step)? {
            StepAdmission::Done(result) => {
                steps.accept(result);
                self.frames.push(Frame::Steps(steps));
            }
            StepAdmission::Solid { operator, first, operand } => {
                let depth = steps.depth;
                self.frames.push(Frame::AfterStep { steps, operator, host: first });
                self.frames.push(Frame::Operand { entity: operand, operator, depth });
            }
        }
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
        program: BooleanProgram::new(std::mem::take(visited), quality, first),
        caller: visited,
    };
    restoring.program.run(&mut Services { recorder, decoder })
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
        *self.caller = std::mem::take(&mut self.program.visited);
    }
}

#[cfg(test)]
mod unwind_tests;
