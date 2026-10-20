// SPDX-License-Identifier: MPL-2.0
//! The left-spine walk and the batched polygonal-chain attempt (issue #960).
//!
//! The FirstOperand spine is walked iteratively, so chain LENGTH never counts
//! against `MAX_BOOLEAN_DEPTH`; the cap only guards genuine operand nesting.
//! Revit exports building-element-part chains 42 DIFFERENCE nodes deep.
use super::super::half_space_plan::HalfSpacePlan;
use super::super::polygonal_group_execution::GroupExecution;
use super::super::boolean_operator;
use super::{BooleanProgram, Frame, Services, Walk};
use crate::{BoolFailureReason, BoolOp, Error, Mesh, Result, TessellationQuality};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

impl BooleanProgram {
    pub(super) fn walk(&mut self, mut walk: Walk, services: &mut Services<'_, '_>) -> Result<()> {
        if !walk.seen.insert(walk.current.id) {
            // Cyclic FirstOperand chain (malformed input): fail with a reason
            // that names the actual problem.
            return Err(Error::geometry(format!(
                "cyclic boolean FirstOperand chain at #{}",
                walk.current.id
            )));
        }
        if !matches!(
            walk.current.ifc_type,
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult
        ) {
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
            let (base, cutters) =
                services.recorder.collect_polygonal_chain(walk.current.clone(), services.decoder)?;
            if cutters.len() >= 2 {
                // Provisional from here: every deferral rewinds to this mark.
                let mark = services.recorder.failure_mark();
                let depth = walk.depth;
                self.frames.push(Frame::AfterBatch { walk, cutters, mark });
                self.frames.push(Frame::Operand { entity: base, operator: BoolOp::Unknown, depth });
                return Ok(());
            }
        }
        self.next_first(walk, services)
    }

    fn next_first(&mut self, mut walk: Walk, services: &mut Services<'_, '_>) -> Result<()> {
        let attr = walk
            .current
            .get(slot::IfcBooleanResult::FIRST_OPERAND.index())
            .ok_or_else(|| Error::geometry("BooleanResult missing FirstOperand".to_string()))?;
        let first = services
            .decoder
            .resolve_ref(attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve FirstOperand".to_string()))?;
        walk.spine.push(walk.current);
        walk.current = first;
        self.frames.push(Frame::Walk(walk));
        Ok(())
    }

    /// The batched chain's base is meshed: cut every prism in one subtract, or
    /// defer to the sequential spine.
    pub(super) fn finish_batch(
        &mut self,
        walk: Walk,
        cutters: Vec<DecodedEntity>,
        mark: usize,
        services: &mut Services<'_, '_>,
    ) -> Result<()> {
        let (base, loss_recorded) = self.take_value()?;
        if base.is_empty() {
            // Nothing to cut. Returned, not deferred (a deferral re-meshes the
            // base at every spine level), with the flag the one-record rule needs.
            self.frames.push(Frame::Steps(walk.steps((base, loss_recorded), true)));
            return Ok(());
        }
        match services.recorder.cut_polygonal_chain(
            &base, &cutters, mark, services.decoder, self.quality)
        {
            Some(mesh) => self.frames.push(Frame::Steps(walk.steps((mesh, false), true))),
            // The attempt already rewound its provisional records. Source
            // reports and operand visits stay spent.
            None => self.next_first(walk, services)?,
        }
        Ok(())
    }
}

impl super::super::BooleanClippingProcessor {
    /// Discard what the provisional attempt recorded and defer.
    fn defer(&self, mark: usize) -> Option<Mesh> {
        self.rewind_to(mark);
        None
    }

    /// Subtract the union of the cutter prisms from `base` in one operation.
    /// `None` defers to the sequential path: a cutter plane is unreadable, a
    /// prism does not build, or batching is not provably safe (see
    /// `execute_polygonal_group`).
    ///
    /// **Measured contract (issue #3980):** `build_cutter_union` does NOT
    /// verify that its union is watertight or manifold. What keeps a non-closed
    /// union from producing a wrong subtraction is downstream: the per-cutter
    /// trial subtracts, the intersected-bounds check, the #3919 accept gate
    /// and the #3925 removal-bound check.
    fn cut_polygonal_chain(
        &self,
        base: &Mesh,
        cutters: &[DecodedEntity],
        mark: usize,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Option<Mesh> {
        let mut prisms: Vec<Mesh> = Vec::with_capacity(cutters.len());
        for cutter in cutters {
            // Unreadable plane: defer; the sequential step records it (#7688).
            let Ok((point, normal, agreement)) =
                HalfSpacePlan::lower(cutter, decoder).map(HalfSpacePlan::components)
            else {
                return self.defer(mark);
            };
            match self.build_polygonal_bounded_half_space_mesh(
                cutter, decoder, base, (point, normal, agreement), quality)
            {
                Ok(Some(prism)) if !prism.is_empty() => prisms.push(prism),
                // A cutter we can't build a prism for would be silently dropped
                // here; defer to the sequential path, which records the loss
                // (fallback, or an over-cap boundary's refusal; the rewind
                // drops ours).
                _ => return self.defer(mark),
            }
        }
        match self.execute_polygonal_group(base, &prisms, decoder.length_unit_scale()) {
            GroupExecution::Defer => self.defer(mark),
            GroupExecution::UnionUnavailable(failures) => {
                self.rewind_to(mark);
                self.absorb_failures(failures);
                self.record_failure(BoolOp::Union, BoolFailureReason::CutterUnionUnavailable);
                None
            }
            GroupExecution::Clipped { mesh, failures } => {
                self.absorb_failures(failures);
                Some(mesh)
            }
        }
    }
}
