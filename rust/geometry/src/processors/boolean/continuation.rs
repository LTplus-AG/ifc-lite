// SPDX-License-Identifier: MPL-2.0
//! Canonical demand-driven control. Source admission happens only at the
//! reached continuation; no recursive boolean/CSG operand evaluation remains.
use super::{BooleanClippingProcessor, OperandPath, MAX_BOOLEAN_DEPTH,
    MAX_OPERAND_PATH_NODES, MAX_OPERAND_VISITS, boolean_operator};
use super::step::StepAdmission;
use crate::{BoolFailureReason, BoolOp, Error, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
#[path = "continuation_state.rs"]
mod state;
#[path = "continuation_batch.rs"]
mod batch;
use state::{Frame, Steps, Value, Walk};

struct Driver<'a, 'source> {
    recorder: &'a BooleanClippingProcessor,
    decoder: &'a mut EntityDecoder<'source>,
    visited: &'a mut OperandPath,
    quality: TessellationQuality,
    frames: Vec<Frame>,
    active: Vec<u32>,
    value: Option<Value>,
}
impl<'a, 'source> Driver<'a, 'source> {
    fn new(recorder: &'a BooleanClippingProcessor, decoder: &'a mut EntityDecoder<'source>,
        visited: &'a mut OperandPath, quality: TessellationQuality, first: Frame) -> Self {
        Self { recorder, decoder, visited, quality, frames: vec![first],
            active: Vec::new(), value: None }
    }
    fn run(mut self) -> Result<Value> {
        let result = self.drive();
        // An error skips queued ExitPath frames. Pop only our own admissions;
        // ancestors supplied by a caller retain their membership and budget.
        for id in self.active { self.visited.remove(id); }
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
    fn enter_boolean(&mut self, entity: DecodedEntity, depth: u32) -> Result<()> {
        if self.visited.len() >= MAX_OPERAND_PATH_NODES {
            return Err(Error::geometry(format!(
                "Boolean/CSG operand chain exceeds {MAX_OPERAND_PATH_NODES} nested nodes at #{}", entity.id)));
        }
        if !self.visited.charge() {
            self.recorder.record_failure(BoolOp::Unknown, BoolFailureReason::OperandBudgetExhausted);
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
    fn enter_csg(&mut self, entity: DecodedEntity, depth: u32, guarded: bool) -> Result<()> {
        if guarded { self.enter_path(entity.id)?; }
        let root = super::super::csg_primitive::resolve_tree_root(&entity, self.decoder)?;
        match root.ifc_type {
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                self.frames.push(Frame::Boolean(root, depth));
            }
            // Root validation admits only these primitive constructors.
            _ => self.value = Some(self.recorder.process_operand_checked(
                BoolOp::Unknown, &root, self.decoder, self.quality)?),
        }
        Ok(())
    }
    fn operand(&mut self, entity: DecodedEntity, operator: BoolOp, depth: u32) -> Result<()> {
        match entity.ifc_type {
            // CSG starts a fresh boolean depth, but retains the current path
            // and monotonic visit count. CSG membership itself is uncharged.
            IfcType::IfcCsgSolid => self.frames.push(Frame::Csg { entity, depth: 0, guarded: true }),
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                self.frames.push(Frame::Boolean(entity, depth + 1));
            }
            _ => self.value = Some(self.recorder.process_operand_checked(
                operator, &entity, self.decoder, self.quality)?),
        }
        Ok(())
    }
    fn drive(&mut self) -> Result<Value> {
        while let Some(frame) = self.frames.pop() {
            match frame {
                Frame::Boolean(entity, depth) => self.enter_boolean(entity, depth)?,
                Frame::Csg { entity, depth, guarded } => self.enter_csg(entity, depth, guarded)?,
                Frame::Operand { entity, operator, depth } => self.operand(entity, operator, depth)?,
                Frame::ExitPath(id) => {
                    self.visited.remove(id);
                    let exited = self.active.pop();
                    debug_assert_eq!(exited, Some(id));
                }
                Frame::Walk(walk) => self.walk(walk)?,
                Frame::AfterBase(walk) => {
                    let value = self.value.take().expect("base continuation result");
                    self.frames.push(Frame::Steps(walk.steps(value, false)));
                }
                Frame::AfterBatch { walk, cutters, mark } => self.finish_batch(walk, cutters, mark)?,
                Frame::Steps(steps) => self.steps(steps)?,
                Frame::AfterStep { mut steps, operator, host } => {
                    let second = self.value.take().expect("operand continuation result");
                    let result = self.recorder.finish_solid_step(
                        operator, host, second, self.decoder, self.quality)?;
                    steps.accept(result);
                    self.frames.push(Frame::Steps(steps));
                }
            }
        }
        Ok(self.value.take().expect("completed operation result"))
    }
    fn steps(&mut self, mut steps: Steps) -> Result<()> {
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
                    self.recorder.record_empty_operand(BoolOp::Union, steps.empty_recorded);
                    steps.empty_recorded = true;
                }
                _ => {}
            }
        }
        let host = std::mem::take(&mut steps.mesh);
        match self.recorder.begin_boolean_step(
            &node, host, self.decoder, self.quality, steps.solo_step)? {
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
        Driver::new(self, decoder, visited, quality, Frame::Boolean(entity.clone(), depth)).run()
    }
    pub(crate) fn execute_csg(&self, entity: &DecodedEntity,
        decoder: &mut EntityDecoder, depth: u32, quality: TessellationQuality,
        visited: &mut OperandPath, guarded: bool) -> Result<Value> {
        Driver::new(self, decoder, visited, quality,
            Frame::Csg { entity: entity.clone(), depth, guarded }).run()
    }
}
