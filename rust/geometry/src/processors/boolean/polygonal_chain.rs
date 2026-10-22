// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Source walk of a left-deep polygonal-bounded half-space chain: preflight
//! for the grouped cutter union, and the batched attempt over it (issue #960).

use super::half_space_plan::HalfSpacePlan;
use super::operand;
use super::polygonal_group_execution::GroupExecution;
use super::BooleanClippingProcessor;
use crate::diagnostics::{BoolFailureReason, BoolOp};
use crate::{Mesh, Result, TessellationQuality};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

impl BooleanClippingProcessor {
    /// Walk the left-spine of a chained
    /// `IfcBooleanClippingResult(.DIFFERENCE., x, polygonalBoundedHalfSpace)`
    /// pattern (typical for gable walls clipped by a segmented roof) and
    /// collect every consecutive `IfcPolygonalBoundedHalfSpace` cutter, plus
    /// the base solid the chain bottoms out on.
    ///
    /// Returns `(base_entity, cutters)` with `cutters` ordered innermost-first.
    /// Consumed by `cut_polygonal_chain`, which unions the cutter
    /// prisms (a true CSG union -- overlap-safe, unlike the old mesh-*merge*
    /// batching) and subtracts once (issue #960: seam slivers + deep-chain
    /// depth-limit drops).
    pub(crate) fn collect_polygonal_chain(
        &self,
        entity: DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(DecodedEntity, Vec<DecodedEntity>)> {
        let mut chain: Vec<DecodedEntity> = Vec::new();
        let mut current = entity;
        // Guard against self-referential / cyclic FirstOperand chains in
        // malformed input (e.g. `#10=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#10,
        // #20)`), which would otherwise walk `current = first` forever and grow
        // `chain` without bound (hang + OOM in the wasm geometry worker, where
        // panic=abort takes down the whole instance). A visited-id set breaks on
        // the first repeat WITHOUT capping legitimate deep-but-finite chains —
        // this walk was made iterative in #960 precisely to bypass
        // MAX_BOOLEAN_DEPTH for those, so a low depth cap would regress them.
        let mut visited: std::collections::HashSet<u32> = std::collections::HashSet::new();
        loop {
            if !visited.insert(current.id) {
                break;
            }
            if !matches!(
                current.ifc_type,
                IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult
            ) {
                break;
            }
            // Operator must be DIFFERENCE (an unreadable one on a bare
            // IfcBooleanResult is not).
            if operand::boolean_operator(&current) != Ok(BoolOp::Difference) {
                break;
            }
            let Some(second_attr) = current.get(slot::IfcBooleanResult::SECOND_OPERAND.index())
            else {
                break;
            };
            let Ok(Some(second)) = decoder.resolve_ref(second_attr) else {
                break;
            };
            if second.ifc_type != IfcType::IfcPolygonalBoundedHalfSpace {
                break;
            }
            chain.push(second);
            let Some(first_attr) = current.get(slot::IfcBooleanResult::FIRST_OPERAND.index())
            else {
                break;
            };
            let Ok(Some(first)) = decoder.resolve_ref(first_attr) else {
                break;
            };
            current = first;
        }
        // Reverse so chain[0] is the innermost (first-applied) clip.
        chain.reverse();
        Ok((current, chain))
    }

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
    pub(crate) fn cut_polygonal_chain(
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
