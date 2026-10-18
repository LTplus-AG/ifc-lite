// SPDX-License-Identifier: MPL-2.0
//! Production use of owned polygonal-candidate source control snapshots.
use super::BooleanClippingProcessor;
use crate::{Error, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

impl BooleanClippingProcessor {
    /// Walk the left-spine of a chained
    /// `IfcBooleanClippingResult(.DIFFERENCE., x, polygonalBoundedHalfSpace)`
    /// pattern (typical for gable walls clipped by a segmented roof) and
    /// collect every consecutive `IfcPolygonalBoundedHalfSpace` cutter, plus
    /// the base solid the chain bottoms out on.
    ///
    /// Returns `(base_entity, cutters)` with `cutters` ordered innermost-first.
    /// Consumed by the batch continuation, which unions the cutter
    /// prisms (a true CSG union — overlap-safe, unlike the old mesh-*merge*
    /// batching) and subtracts once. See that method for why a single unioned
    /// subtract beats sequential subtraction here (issue #960: seam slivers +
    /// deep-chain depth-limit drops).
    pub(super) fn collect_polygonal_chain(
        &self,
        entity: DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(DecodedEntity, Vec<DecodedEntity>)> {
        use super::spine_plan::{Admission, BatchCandidate, SpineEnd};
        let plan = super::spine_plan::lower_polygonal_candidate(&entity, decoder, usize::MAX, usize::MAX);
        // Match the actual source-read order of this provisional attempt.
        for node in &plan.nodes {
            crate::processors::diagnostic_capture::restore(&node.second.reports);
            crate::processors::diagnostic_capture::restore(&node.first.reports);
        }
        if plan.nodes.is_empty() {
            return match plan.end {
                SpineEnd::Base(base) => Ok((base, Vec::new())),
                SpineEnd::FirstFault(index) => Err(Error::geometry(format!("Missing boolean source node {index}"))),
                SpineEnd::Cycle(id) => Err(Error::geometry(format!("Missing cyclic source node #{id}"))),
                SpineEnd::Limited { source_id, reason } => Err(Error::geometry(format!(
                    "Boolean source admission limited at #{source_id}: {reason:?}"))),
            };
        }
        let candidate = plan.candidates.first().copied().unwrap_or(BatchCandidate { start_node: 0 });
        let collected = plan.collect_candidate(candidate, usize::MAX);
        let base = match collected.base {
            Admission::Resolved(base) => base,
            Admission::Fault(error) => return Err(Error::geometry(error.to_string())),
            Admission::Limited(reason) => return Err(Error::geometry(format!("Boolean source admission limited: {reason:?}"))),
            Admission::Unused => return Err(Error::geometry("Boolean source candidate has no base")),
        };
        let cutters = collected.cutters.into_iter().map(|index| {
            match &plan.nodes[index].second.admission {
                Admission::Resolved(entity) => entity.clone(),
                _ => unreachable!("admitted polygonal candidate has a cutter snapshot"),
            }
        }).collect();
        Ok((base, cutters))
    }

}
