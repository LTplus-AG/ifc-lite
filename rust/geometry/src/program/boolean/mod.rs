// SPDX-License-Identifier: MPL-2.0
//! The Boolean/CSG continuation of one reached boolean or `IfcCsgSolid`
//! item, owned by the common program. Operand nesting lives on an owned
//! frame stack, so no boolean, CSG-hop or spine step recurses on the native
//! stack, and every step is a program request: source steps read the
//! decoder through the selected processor's recorder, the solid/solid
//! boolean is a numerical step over its already-meshed operands, and pure
//! control frames (path scopes, depth and budget admission, operand
//! dispatch) settle after each step without reading source.
//!
//! The path set is PATH-scoped, not global: a boolean tree is a DAG and one
//! operand legitimately referenced down two different branches must be present
//! in both (the accumulation is the parent's subtract, not the node's, and a
//! memo could serve the second branch; see `MAX_OPERAND_VISITS`). Removing an
//! id when its scope exits breaks cycles without dropping real geometry. The
//! path length bounds operand nesting across the CSG hop, which passes `depth`
//! restarted at 0, and the monotonic visit charge bounds shared fan-out.
use super::inner::ProgramStage;
use crate::processors::boolean::{
    boolean_operator, OperandPath, StepAdmission, MAX_BOOLEAN_DEPTH, MAX_OPERAND_PATH_NODES,
    MAX_OPERAND_VISITS,
};
use crate::processors::boolean::solid_execution::SolidBooleanPlan;
use crate::processors::csg_primitive::{primitive_root_mesh, resolve_tree_root};
use crate::processors::BooleanClippingProcessor;
use crate::{BoolFailureReason, BoolOp, Error, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

mod state;
mod walk;
use state::{Frame, Steps, Value, Walk};

/// Owned continuation state. Holds no decoder and no processor: each step
/// borrows the selected processor's recorder (and, at source, the decoder).
pub(crate) struct BooleanMachine {
    visited: OperandPath,
    quality: TessellationQuality,
    frames: Vec<Frame>,
    value: Option<Value>,
}

impl BooleanMachine {
    /// The continuation of a reached `IfcBooleanResult` /
    /// `IfcBooleanClippingResult`, or of an `IfcCsgSolid` (its top-level entry
    /// does not admit its own id to the operand path).
    pub(crate) fn new(item: &DecodedEntity, quality: TessellationQuality) -> Self {
        let first = match item.ifc_type {
            IfcType::IfcCsgSolid => Frame::Csg { entity: item.clone(), depth: 0, guarded: false },
            _ => Frame::Boolean(item.clone(), 0),
        };
        Self { visited: OperandPath::default(), quality, frames: vec![first], value: None }
    }

    /// The next step's stage; `None` once the continuation completed.
    pub(crate) fn stage(&self) -> Option<ProgramStage> {
        match self.frames.last()? {
            Frame::Solid { .. } => Some(ProgramStage::Numerical),
            _ => Some(ProgramStage::Source),
        }
    }

    /// Run the source step at the top of the stack, then settle.
    pub(crate) fn source(&mut self, recorder: &BooleanClippingProcessor, decoder: &mut EntityDecoder)
        -> Result<()> {
        let Some(frame) = self.frames.pop() else { return Err(stale()) };
        self.run(frame, recorder, decoder)?;
        self.settle(recorder)
    }

    /// Run the numerical step at the top of the stack, then settle. Reads no
    /// source.
    pub(crate) fn numerical(&mut self, recorder: &BooleanClippingProcessor) -> Result<()> {
        let Some(Frame::Solid { mut steps, plan, host, second }) = self.frames.pop() else {
            return Err(stale());
        };
        let (second, loss_recorded) = second;
        steps.accept(plan.evaluate(recorder, host, second, loss_recorded)?);
        self.frames.push(Frame::Steps(steps));
        self.settle(recorder)
    }

    /// The completed continuation's value: the mesh, and whether it is empty
    /// with its loss already on record (#4691).
    pub(crate) fn finish(&mut self) -> Result<Value> {
        if !self.frames.is_empty() {
            return Err(stale());
        }
        self.take_value()
    }

    /// Drive every step synchronously with one recorder and decoder: the
    /// selected processor's own `process` entry.
    pub(crate) fn drain(mut self, recorder: &BooleanClippingProcessor, decoder: &mut EntityDecoder)
        -> Result<Value> {
        while let Some(stage) = self.stage() {
            match stage {
                ProgramStage::Numerical => self.numerical(recorder)?,
                _ => self.source(recorder, decoder)?,
            }
        }
        self.finish()
    }

    /// Pop the control frames at the top of the stack. None reads source.
    fn settle(&mut self, recorder: &BooleanClippingProcessor) -> Result<()> {
        while self.frames.last().is_some_and(Frame::is_control) {
            if let Some(frame) = self.frames.pop() {
                self.control(frame, recorder)?;
            }
        }
        Ok(())
    }

    fn control(&mut self, frame: Frame, recorder: &BooleanClippingProcessor) -> Result<()> {
        match frame {
            Frame::Boolean(entity, depth) => self.enter_boolean(entity, depth, recorder),
            Frame::Operand { entity, depth, .. } => {
                self.dispatch(entity, depth);
                Ok(())
            }
            Frame::ExitPath(id) => {
                self.visited.remove(id);
                Ok(())
            }
            Frame::AfterBase(walk) => {
                let value = self.take_value()?;
                self.frames.push(Frame::Steps(walk.steps(value, false)));
                Ok(())
            }
            _ => Err(stale()),
        }
    }

    fn run(&mut self, frame: Frame, recorder: &BooleanClippingProcessor, decoder: &mut EntityDecoder)
        -> Result<()> {
        match frame {
            Frame::Csg { entity, depth, guarded } => self.enter_csg(entity, depth, guarded, recorder, decoder),
            Frame::Operand { entity, operator, .. } if !Frame::dispatches(&entity) => {
                self.value = Some(recorder.leaf_operand(operator, &entity, decoder, self.quality)?);
                Ok(())
            }
            Frame::Walk(walk) => self.walk(walk, recorder, decoder),
            Frame::AfterBatch { walk, cutters, mark } => self.finish_batch(walk, cutters, mark, recorder, decoder),
            Frame::Steps(steps) => self.steps(steps, recorder, decoder),
            Frame::AfterStep { steps, operator, host } => {
                // The unit scale is read after the operand: it can be
                // discovered late. The boolean itself is the next, numerical step.
                let second = self.take_value()?;
                let plan = SolidBooleanPlan {
                    operator,
                    length_unit_scale: decoder.length_unit_scale(),
                    quality: self.quality,
                    skip_small_cuts: recorder.skip_small_cuts(),
                };
                self.frames.push(Frame::Solid { steps, plan, host, second });
                Ok(())
            }
            control => self.control(control, recorder),
        }
    }

    fn enter_path(&mut self, id: u32) -> Result<()> {
        if !self.visited.insert(id) {
            return Err(Error::geometry(format!("Cyclic boolean/CSG operand reference at #{id}")));
        }
        self.frames.push(Frame::ExitPath(id));
        Ok(())
    }

    fn enter_boolean(&mut self, entity: DecodedEntity, depth: u32, recorder: &BooleanClippingProcessor)
        -> Result<()> {
        // The path length bounds one operand chain; it is the only bound on a
        // long acyclic Boolean -> Csg -> Boolean chain, which never advances
        // MAX_BOOLEAN_DEPTH.
        if self.visited.len() >= MAX_OPERAND_PATH_NODES {
            return Err(Error::geometry(format!(
                "Boolean/CSG operand chain exceeds {MAX_OPERAND_PATH_NODES} nested nodes at #{}",
                entity.id
            )));
        }
        // The work budget: a shared SecondOperand is re-meshed on every path
        // that reaches it. Recorded AND refused: the record is what a consumer
        // sees, the `Err` is what stops the work.
        if !self.visited.charge() {
            recorder.record_failure(BoolOp::Unknown, BoolFailureReason::OperandBudgetExhausted);
            return Err(Error::geometry(format!(
                "Boolean/CSG operand walk exceeds {MAX_OPERAND_VISITS} node visits at #{}",
                entity.id
            )));
        }
        self.enter_path(entity.id)?;
        if depth > MAX_BOOLEAN_DEPTH {
            return Err(Error::geometry(format!(
                "Boolean nesting depth {depth} exceeds limit {MAX_BOOLEAN_DEPTH}"
            )));
        }
        self.frames.push(Frame::Walk(Walk::new(entity, depth)));
        Ok(())
    }

    fn enter_csg(&mut self, entity: DecodedEntity, depth: u32, guarded: bool,
        recorder: &BooleanClippingProcessor, decoder: &mut EntityDecoder) -> Result<()> {
        if guarded {
            self.enter_path(entity.id)?;
        }
        let root = resolve_tree_root(&entity, decoder)?;
        match root.ifc_type {
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                self.frames.push(Frame::Boolean(root, depth));
            }
            // `resolve_tree_root` admits only booleans and the primitives.
            _ => {
                let mesh = primitive_root_mesh(&root, decoder, recorder.schema(), self.quality)?;
                self.value = Some((mesh, false));
            }
        }
        Ok(())
    }

    /// A recursive operand continues on the stack.
    fn dispatch(&mut self, entity: DecodedEntity, depth: u32) {
        match entity.ifc_type {
            // A CSG solid starts a fresh boolean depth but keeps the current
            // path and visit count. Carrying `depth` across would tighten
            // MAX_BOOLEAN_DEPTH, which #960 calibrated against a reset here.
            IfcType::IfcCsgSolid => self.frames.push(Frame::Csg { entity, depth: 0, guarded: true }),
            _ => self.frames.push(Frame::Boolean(entity, depth + 1)),
        }
    }

    fn take_value(&mut self) -> Result<Value> {
        self.value
            .take()
            .ok_or_else(|| Error::geometry("Boolean continuation completed without a value"))
    }

    /// Apply the next spine node, innermost first.
    fn steps(&mut self, mut steps: Steps, recorder: &BooleanClippingProcessor, decoder: &mut EntityDecoder)
        -> Result<()> {
        let Some(node) = steps.nodes.pop() else {
            self.value = Some((steps.mesh, steps.empty_recorded));
            return Ok(());
        };
        if steps.mesh.is_empty() {
            match boolean_operator(&node) {
                // DIFFERENCE or INTERSECTION of nothing is nothing: skip the
                // step (a UNION higher up still gets its second operand).
                Ok(BoolOp::Difference | BoolOp::Intersection) => {
                    self.frames.push(Frame::Steps(steps));
                    return Ok(());
                }
                // UNION(empty, B) = B: the step runs on the second operand
                // alone, and the emptied first operand is on record once.
                Ok(BoolOp::Union) => {
                    recorder.record_empty_operand(BoolOp::Union, steps.empty_recorded);
                    steps.empty_recorded = true;
                }
                // Unknown or unreadable: the step records it, mesh unchanged.
                Ok(BoolOp::Unknown) | Err(_) => {}
            }
        }
        let host = std::mem::take(&mut steps.mesh);
        match recorder.begin_boolean_step(&node, host, decoder, self.quality, steps.solo_step)? {
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

fn stale() -> Error {
    Error::geometry("Boolean continuation step requested out of order")
}

#[cfg(test)]
mod tests;
