// SPDX-License-Identifier: MPL-2.0
//! The left-spine walk and the batched polygonal-chain attempt (issue #960).
//!
//! The FirstOperand spine is walked iteratively, so chain LENGTH never counts
//! against `MAX_BOOLEAN_DEPTH`; the cap only guards genuine operand nesting.
//! Revit exports building-element-part chains 42 DIFFERENCE nodes deep.
use super::state::{Batch, CutPlane};
use super::{BooleanMachine, Frame, Walk};
use crate::processors::boolean::{boolean_operator, BoundedPrismPlan, GroupExecution, HalfSpacePlan};
use crate::processors::BooleanClippingProcessor;
use crate::{BoolFailureReason, BoolOp, Error, Result};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

impl BooleanMachine {
    pub(super) fn walk(&mut self, mut walk: Walk, recorder: &BooleanClippingProcessor,
        decoder: &mut EntityDecoder) -> Result<()> {
        if !walk.seen.insert(walk.current.id) {
            // Cyclic FirstOperand chain (malformed input): fail with a reason
            // that names the actual problem.
            return Err(Error::geometry(format!("cyclic boolean FirstOperand chain at #{}", walk.current.id)));
        }
        if !matches!(walk.current.ifc_type, IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult) {
            // Bottom of the spine: the base solid.
            let entity = walk.current.clone();
            let depth = walk.depth;
            self.frames.push(Frame::AfterBase(walk));
            self.frames.push(Frame::Operand { entity, operator: BoolOp::Unknown, depth });
            return Ok(());
        }
        if boolean_operator(&walk.current) == Ok(BoolOp::Difference) {
            // The batched attempt meshes the base provisionally and can be
            // retried at every spine level it defers on. Those are real node
            // entries and remain charged: refunding them would let nested
            // deferrals do exponential work behind a linear counter.
            let (base, cutters) = recorder.collect_polygonal_chain(walk.current.clone(), decoder)?;
            if cutters.len() >= 2 {
                // Provisional from here: every deferral rewinds to this mark.
                let mark = recorder.failure_mark();
                let depth = walk.depth;
                self.frames.push(Frame::AfterBatch { walk, cutters, mark });
                self.frames.push(Frame::Operand { entity: base, operator: BoolOp::Unknown, depth });
                return Ok(());
            }
        }
        self.next_first(walk, decoder)
    }

    pub(super) fn next_first(&mut self, mut walk: Walk, decoder: &mut EntityDecoder) -> Result<()> {
        let attr = walk
            .current
            .get(slot::IfcBooleanResult::FIRST_OPERAND.index())
            .ok_or_else(|| Error::geometry("BooleanResult missing FirstOperand".to_string()))?;
        let first = decoder
            .resolve_ref(attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve FirstOperand".to_string()))?;
        walk.spine.push(walk.current);
        walk.current = first;
        self.frames.push(Frame::Walk(walk));
        Ok(())
    }

    /// The batched chain's base is meshed: admit its cutters, or return an
    /// empty base. Reads no source.
    pub(super) fn after_batch(&mut self, walk: Walk, cutters: Vec<DecodedEntity>, mark: usize) -> Result<()> {
        let (base, loss_recorded) = self.take_value()?;
        if base.is_empty() {
            // Nothing to cut. Returned, not deferred (a deferral re-meshes the
            // base at every spine level), with the flag the one-record rule needs.
            self.frames.push(Frame::Steps(walk.steps((base, loss_recorded), true)));
            return Ok(());
        }
        let prisms = Vec::with_capacity(cutters.len());
        self.frames.push(Frame::BatchLower(Batch { walk, cutters, mark, base, prisms, length_unit_scale: 1.0 }));
        Ok(())
    }

    /// Admit the next cutter's plane and prism boundary, in cutter order. An
    /// unreadable plane or boundary defers; the sequential step records it
    /// (#7688), and the rewind drops what this attempt recorded.
    pub(super) fn batch_lower(&mut self, mut batch: Batch, recorder: &BooleanClippingProcessor,
        decoder: &mut EntityDecoder) -> Result<()> {
        let Some(cutter) = batch.cutters.get(batch.prisms.len()) else { return Err(super::stale()) };
        let Ok(plane) = HalfSpacePlan::lower(cutter, decoder).map(HalfSpacePlan::components) else {
            return self.defer(batch, recorder);
        };
        let Ok(Some(prism)) = BoundedPrismPlan::lower(recorder, cutter, decoder, self.quality) else {
            return self.defer(batch, recorder);
        };
        // The group's unit scale is read with its last cutter.
        batch.length_unit_scale = decoder.length_unit_scale();
        self.frames.push(Frame::BatchBuild(batch, plane, prism));
        Ok(())
    }

    /// Build one cutter's prism around the base. A cutter we can't build a
    /// prism for would be silently dropped here; defer to the sequential path,
    /// which records the loss. Reads no source.
    pub(super) fn batch_build(&mut self, mut batch: Batch, plane: CutPlane, prism: BoundedPrismPlan,
        recorder: &BooleanClippingProcessor) -> Result<()> {
        match prism.build_mesh(&batch.base, plane) {
            Ok(prism) if !prism.is_empty() => batch.prisms.push(prism),
            _ => return self.defer(batch, recorder),
        }
        let frame = match batch.prisms.len() == batch.cutters.len() {
            true => Frame::BatchGroup(batch),
            false => Frame::BatchLower(batch),
        };
        self.frames.push(frame);
        Ok(())
    }

    /// Subtract the union of the cutter prisms from the base in one operation,
    /// or defer when batching is not provably safe (see
    /// `execute_polygonal_group`). Reads no source.
    ///
    /// **Measured contract (issue #3980):** `build_cutter_union` does NOT
    /// verify that its union is watertight or manifold. What keeps a non-closed
    /// union from producing a wrong subtraction is downstream: the per-cutter
    /// trial subtracts, the intersected-bounds check, the #3919 accept gate
    /// and the #3925 removal-bound check.
    pub(super) fn batch_group(&mut self, batch: Batch, recorder: &BooleanClippingProcessor) -> Result<()> {
        match recorder.execute_polygonal_group(&batch.base, &batch.prisms, batch.length_unit_scale) {
            GroupExecution::Defer => self.defer(batch, recorder),
            GroupExecution::UnionUnavailable(failures) => {
                recorder.rewind_to(batch.mark);
                recorder.absorb_failures(failures);
                recorder.record_failure(BoolOp::Union, BoolFailureReason::CutterUnionUnavailable);
                self.frames.push(Frame::Defer(batch.walk));
                Ok(())
            }
            GroupExecution::Clipped { mesh, failures } => {
                recorder.absorb_failures(failures);
                self.frames.push(Frame::Steps(batch.walk.steps((mesh, false), true)));
                Ok(())
            }
        }
    }

    /// Discard what the provisional attempt recorded and resume the spine.
    /// Source reports and operand visits stay spent.
    fn defer(&mut self, batch: Batch, recorder: &BooleanClippingProcessor) -> Result<()> {
        recorder.rewind_to(batch.mark);
        self.frames.push(Frame::Defer(batch.walk));
        Ok(())
    }
}
