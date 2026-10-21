// SPDX-License-Identifier: MPL-2.0
//! The Boolean/CSG continuation of one reached boolean or `IfcCsgSolid`
//! item, owned by the common program. Operand nesting lives on an owned
//! frame stack, so no boolean, CSG-hop or spine step recurses on the native
//! stack, and every step is a program request: source steps read the
//! decoder through the selected processor's recorder (the spine walk, the
//! CSG hop, a leaf operand, a spine node's operator and SecondOperand, a
//! cutter's plane or prism boundary); numerical steps are owned arithmetic
//! over meshed operands (the plane clip, the kept-side check, the bounded
//! prism build and subtract, the batched group, the solid/solid boolean);
//! pure control frames (path scopes, depth and budget admission, operand
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
use crate::processors::boolean::{OperandPath, MAX_BOOLEAN_DEPTH, MAX_OPERAND_PATH_NODES, MAX_OPERAND_VISITS};
use crate::processors::boolean::solid_execution::SolidBooleanPlan;
use crate::processors::csg_primitive::{primitive_root_mesh, resolve_tree_root};
use crate::processors::BooleanClippingProcessor;
use crate::{BoolFailureReason, BoolOp, Error, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

mod spine;
mod state;
mod walk;
use state::{Frame, Value, Walk};

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
        match self.frames.last()?.is_numerical() {
            true => Some(ProgramStage::Numerical),
            false => Some(ProgramStage::Source),
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
        match self.frames.pop() {
            Some(Frame::Solid { steps, plan, host, second: (second, loss_recorded) }) => {
                let result = plan.evaluate(recorder, host, second, loss_recorded)?;
                self.applied(steps, result)?;
            }
            Some(Frame::HalfSpace { cut, plan }) => self.half_space(cut, plan, recorder)?,
            Some(Frame::Polygonal { cut, cutter, plane }) => self.polygonal(cut, cutter, plane)?,
            Some(Frame::PolygonalCut { cut, plane, prism, length_unit_scale }) => {
                self.polygonal_cut(cut, plane, prism, length_unit_scale, recorder)?
            }
            Some(Frame::BatchBuild(batch, plane, prism)) => self.batch_build(batch, plane, prism, recorder)?,
            Some(Frame::BatchGroup(batch)) => self.batch_group(batch, recorder)?,
            _ => return Err(stale()),
        }
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
            let stepped = match stage {
                ProgramStage::Numerical => self.numerical(recorder),
                _ => self.source(recorder, decoder),
            };
            if let Err(error) = stepped {
                self.abandon_on_stop(&error, recorder);
                return Err(error);
            }
        }
        self.finish()
    }

    /// Drop this continuation because a resource stop ended its item. A
    /// batched polygonal-chain attempt still pending holds records its base
    /// meshing made provisionally, which only the attempt's own commit or
    /// deferral retracts; the stop skips both, so retract them here. Other
    /// errors keep what was recorded, as they always have.
    pub(crate) fn abandon_on_stop(&mut self, error: &Error, recorder: &BooleanClippingProcessor) {
        if matches!(error, Error::ProgramStopped(_)) {
            self.abandon(recorder);
        }
    }

    /// Retract the provisional records of the outermost pending batched
    /// attempt (marks only grow up the stack, so the first is the lowest).
    pub(crate) fn abandon(&mut self, recorder: &BooleanClippingProcessor) {
        let pending = self.frames.iter().find_map(|frame| match frame {
            Frame::AfterBatch { mark, .. } => Some(*mark),
            _ => None,
        });
        if let Some(mark) = pending {
            recorder.rewind_to(mark);
        }
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
            Frame::AfterBatch { walk, cutters, mark } => self.after_batch(walk, cutters, mark),
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
            Frame::Steps(steps) => self.steps(steps, recorder, decoder),
            Frame::PolygonalPrism { cut, cutter, plane } => self.polygonal_prism(cut, cutter, plane, recorder, decoder),
            Frame::BatchLower(batch) => self.batch_lower(batch, recorder, decoder),
            Frame::Defer(walk) => self.next_first(walk, decoder),
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
            frame if frame.is_numerical() => Err(stale()),
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
}

pub(super) fn stale() -> Error {
    Error::geometry("Boolean continuation step requested out of order")
}

#[cfg(test)]
mod tests;
