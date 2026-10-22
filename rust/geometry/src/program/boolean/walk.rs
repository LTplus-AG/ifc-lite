// SPDX-License-Identifier: MPL-2.0
//! The left-spine walk and the batched polygonal-chain attempt (issue #960).
//!
//! The FirstOperand spine is walked iteratively, so chain LENGTH never counts
//! against `MAX_BOOLEAN_DEPTH`; the cap only guards genuine operand nesting.
//! Revit exports building-element-part chains 42 DIFFERENCE nodes deep.
use super::{BooleanMachine, Frame, Walk};
use crate::processors::boolean::boolean_operator;
use crate::processors::BooleanClippingProcessor;
use crate::{BoolOp, Error, Result};
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

    fn next_first(&mut self, mut walk: Walk, decoder: &mut EntityDecoder) -> Result<()> {
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

    /// The batched chain's base is meshed: cut every prism in one subtract, or
    /// defer to the sequential spine.
    pub(super) fn finish_batch(&mut self, walk: Walk, cutters: Vec<DecodedEntity>, mark: usize,
        recorder: &BooleanClippingProcessor, decoder: &mut EntityDecoder) -> Result<()> {
        let (base, loss_recorded) = self.take_value()?;
        if base.is_empty() {
            // Nothing to cut. Returned, not deferred (a deferral re-meshes the
            // base at every spine level), with the flag the one-record rule needs.
            self.frames.push(Frame::Steps(walk.steps((base, loss_recorded), true)));
            return Ok(());
        }
        match recorder.cut_polygonal_chain(&base, &cutters, mark, decoder, self.quality) {
            Some(mesh) => self.frames.push(Frame::Steps(walk.steps((mesh, false), true))),
            // The attempt already rewound its provisional records. Source
            // reports and operand visits stay spent.
            None => self.next_first(walk, decoder)?,
        }
        Ok(())
    }
}
