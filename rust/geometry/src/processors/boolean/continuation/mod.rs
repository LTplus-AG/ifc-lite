// SPDX-License-Identifier: MPL-2.0
//! Explicit boolean/CSG continuation. Operand nesting lives on a heap frame
//! stack, so no boolean, CSG-hop or spine step recurses on the native stack.
//!
//! The path set is PATH-scoped, not global: a boolean tree is a DAG and one
//! operand legitimately referenced down two different branches must be present
//! in both (the accumulation is the parent's subtract, not the node's, and a
//! memo could serve the second branch; see `MAX_OPERAND_VISITS`). Removing an
//! id when its scope exits breaks cycles without dropping real geometry. The
//! path length bounds operand nesting across the CSG hop, which passes `depth`
//! restarted at 0, and the monotonic visit charge bounds shared fan-out.
use super::{
    boolean_operator, BooleanClippingProcessor, OperandPath, MAX_BOOLEAN_DEPTH,
    MAX_OPERAND_PATH_NODES, MAX_OPERAND_VISITS,
};
use crate::processors::csg_primitive::{primitive_root_mesh, resolve_tree_root};
use crate::{BoolFailureReason, BoolOp, Error, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

mod state;
mod step;
mod walk;
use state::{Frame, Steps, Value, Walk};
use step::StepAdmission;

#[cfg(test)]
mod tests;

/// Ephemeral services borrowed only while driving a reached transition.
struct Services<'a, 'source> {
    recorder: &'a BooleanClippingProcessor,
    decoder: &'a mut EntityDecoder<'source>,
}

/// Owned control state. Holds no decoder and no processor.
struct BooleanProgram {
    visited: OperandPath,
    quality: TessellationQuality,
    frames: Vec<Frame>,
    /// Ids this program admitted to `visited` and has not yet released.
    active: Vec<u32>,
    value: Option<Value>,
}

impl BooleanProgram {
    fn new(visited: OperandPath, quality: TessellationQuality, first: Frame) -> Self {
        Self { visited, quality, frames: vec![first], active: Vec::new(), value: None }
    }

    fn enter_path(&mut self, id: u32) -> Result<()> {
        if !self.visited.insert(id) {
            return Err(Error::geometry(format!("Cyclic boolean/CSG operand reference at #{id}")));
        }
        self.active.push(id);
        self.frames.push(Frame::ExitPath(id));
        Ok(())
    }

    fn enter_boolean(
        &mut self,
        entity: DecodedEntity,
        depth: u32,
        services: &mut Services<'_, '_>,
    ) -> Result<()> {
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
            services.recorder.record_failure(BoolOp::Unknown, BoolFailureReason::OperandBudgetExhausted);
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

    fn enter_csg(
        &mut self,
        entity: DecodedEntity,
        depth: u32,
        guarded: bool,
        services: &mut Services<'_, '_>,
    ) -> Result<()> {
        if guarded {
            self.enter_path(entity.id)?;
        }
        let root = resolve_tree_root(&entity, services.decoder)?;
        match root.ifc_type {
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                self.frames.push(Frame::Boolean(root, depth));
            }
            // `resolve_tree_root` admits only booleans and the primitives.
            _ => {
                let mesh = primitive_root_mesh(
                    &root, services.decoder, &services.recorder.schema, self.quality)?;
                self.value = Some((mesh, false));
            }
        }
        Ok(())
    }

    fn operand(
        &mut self,
        entity: DecodedEntity,
        operator: BoolOp,
        depth: u32,
        services: &mut Services<'_, '_>,
    ) -> Result<()> {
        match entity.ifc_type {
            // A CSG solid starts a fresh boolean depth but keeps the current
            // path and visit count. Carrying `depth` across would tighten
            // MAX_BOOLEAN_DEPTH, which #960 calibrated against a reset here.
            IfcType::IfcCsgSolid => self.frames.push(Frame::Csg { entity, depth: 0, guarded: true }),
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                self.frames.push(Frame::Boolean(entity, depth + 1));
            }
            _ => {
                self.value = Some(services.recorder.leaf_operand(
                    operator, &entity, services.decoder, self.quality)?);
            }
        }
        Ok(())
    }

    fn take_value(&mut self) -> Result<Value> {
        self.value
            .take()
            .ok_or_else(|| Error::geometry("Boolean continuation completed without a value"))
    }

    fn drive(&mut self, services: &mut Services<'_, '_>) -> Result<Value> {
        while let Some(frame) = self.frames.pop() {
            match frame {
                Frame::Boolean(entity, depth) => self.enter_boolean(entity, depth, services)?,
                Frame::Csg { entity, depth, guarded } => {
                    self.enter_csg(entity, depth, guarded, services)?
                }
                Frame::Operand { entity, operator, depth } => {
                    self.operand(entity, operator, depth, services)?
                }
                Frame::ExitPath(id) => {
                    self.visited.remove(id);
                    let exited = self.active.pop();
                    debug_assert_eq!(exited, Some(id));
                }
                Frame::Walk(walk) => self.walk(walk, services)?,
                Frame::AfterBase(walk) => {
                    let value = self.take_value()?;
                    #[cfg(test)]
                    tests::after_base(&value);
                    self.frames.push(Frame::Steps(walk.steps(value, false)));
                }
                Frame::AfterBatch { walk, cutters, mark } => {
                    self.finish_batch(walk, cutters, mark, services)?
                }
                Frame::Steps(steps) => self.steps(steps, services)?,
                Frame::AfterStep { mut steps, operator, host } => {
                    let second = self.take_value()?;
                    let result = services.recorder.finish_solid_step(
                        operator, host, second, services.decoder, self.quality)?;
                    steps.accept(result);
                    self.frames.push(Frame::Steps(steps));
                }
            }
        }
        self.take_value()
    }

    /// Apply the next spine node, innermost first.
    fn steps(&mut self, mut steps: Steps, services: &mut Services<'_, '_>) -> Result<()> {
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
                    services.recorder.record_empty_operand(BoolOp::Union, steps.empty_recorded);
                    steps.empty_recorded = true;
                }
                // Unknown or unreadable: the step records it, mesh unchanged.
                Ok(BoolOp::Unknown) | Err(_) => {}
            }
        }
        let host = std::mem::take(&mut steps.mesh);
        match services.recorder.begin_boolean_step(
            &node, host, services.decoder, self.quality, steps.solo_step)?
        {
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
    /// Run the boolean node `entity` to completion on the explicit stack. The
    /// `bool` is true only when the mesh is empty and its loss is already on
    /// record, so a parent that meshed this node as an operand does not record
    /// it again (#4691).
    pub(crate) fn execute_boolean(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
        quality: TessellationQuality,
        visited: &mut OperandPath,
    ) -> Result<Value> {
        run(self, decoder, visited, quality, Frame::Boolean(entity.clone(), depth))
    }

    /// Run an `IfcCsgSolid` to completion. `guarded` admits its id to the
    /// path (the operand hop); the top-level entry is unguarded.
    pub(crate) fn execute_csg(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
        quality: TessellationQuality,
        visited: &mut OperandPath,
        guarded: bool,
    ) -> Result<Value> {
        run(self, decoder, visited, quality, Frame::Csg { entity: entity.clone(), depth, guarded })
    }
}

fn run(
    recorder: &BooleanClippingProcessor,
    decoder: &mut EntityDecoder,
    visited: &mut OperandPath,
    quality: TessellationQuality,
    first: Frame,
) -> Result<Value> {
    let mut restoring = RestoringProgram {
        program: BooleanProgram::new(std::mem::take(visited), quality, first),
        caller: visited,
    };
    restoring.program.drive(&mut Services { recorder, decoder })
}

/// Return the owned path to the caller on every exit: a normal result, an
/// error that skipped the queued exits, or a panic from numerical or source
/// work. Our own admissions are released; the ancestors and the monotonic
/// visit budget the enclosing caller owns are preserved.
struct RestoringProgram<'a> {
    program: BooleanProgram,
    caller: &'a mut OperandPath,
}

impl Drop for RestoringProgram<'_> {
    fn drop(&mut self) {
        for id in self.program.active.drain(..) {
            self.program.visited.remove(id);
        }
        *self.caller = std::mem::take(&mut self.program.visited);
    }
}
