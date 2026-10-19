// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Source walk of a left-deep polygonal-bounded half-space chain: preflight
//! for the grouped cutter union.

use super::operand;
use super::BooleanClippingProcessor;
use crate::diagnostics::BoolOp;
use crate::Result;
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

impl BooleanClippingProcessor {
    /// Walk the left-spine of a chained
    /// `IfcBooleanClippingResult(.DIFFERENCE., x, polygonalBoundedHalfSpace)`
    /// pattern (typical for gable walls clipped by a segmented roof) and
    /// collect every consecutive `IfcPolygonalBoundedHalfSpace` cutter, plus
    /// the base solid the chain bottoms out on.
    ///
    /// Returns `(base_entity, cutters)` with `cutters` ordered innermost-first.
    /// Consumed by `try_union_polygonal_chain`, which unions the cutter
    /// prisms (a true CSG union -- overlap-safe, unlike the old mesh-*merge*
    /// batching) and subtracts once (issue #960: seam slivers + deep-chain
    /// depth-limit drops).
    pub(super) fn collect_polygonal_chain(
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
}
