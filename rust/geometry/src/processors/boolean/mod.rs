// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! BooleanClipping processor - CSG operations.
//!
//! Handles IfcBooleanResult and IfcBooleanClippingResult for boolean operations
//! (DIFFERENCE, UNION, INTERSECTION).

#[cfg(test)]
use crate::{BoolFailureReason, BoolOp};
use crate::{
    Mesh, Result, TessellationQuality,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema};


pub(crate) mod brep_voids;
mod cut_heuristics;
mod failures;
mod effects;
pub(crate) use effects::NumericalEffects;
pub(crate) mod operand;
mod halfspace_cap;
pub(crate) mod half_space_plan;
pub(crate) mod spine_plan;
mod polygonal_boundary;
pub(crate) mod polygonal_prism;
pub(crate) mod single_cutter_gate;
pub(crate) mod solid_execution;
mod polygonal_union;
mod polygonal_group_execution;
mod polygonal_candidate;
mod polygonal_removal;
#[cfg(test)]
use halfspace_cap::cap_half_space_clip;
#[cfg(test)]
use halfspace_cap::force_cdt_fail_on_ring_for_test;

/// Contextual boolean nesting, including the historical CSG depth reset.
pub(crate) const MAX_BOOLEAN_DEPTH: u32 = 10;
/// Boolean and CSG nodes on one active operand path; left-spine nodes do not
/// contribute. Kept for compatibility even though execution is now iterative.
pub(crate) const MAX_OPERAND_PATH_NODES: usize = 64;

pub(crate) use operand::{OperandPath, MAX_OPERAND_VISITS};
pub(crate) use operand::boolean_operator;

/// BooleanResult processor
/// Handles IfcBooleanResult and IfcBooleanClippingResult - CSG operations
///
/// Supports all IFC boolean operations:
/// - DIFFERENCE: Subtracts second operand from first (wall clipped by roof, openings, etc.)
///   - Uses efficient plane clipping for IfcHalfSpaceSolid operands
///   - Uses full 3D CSG for solid-solid operations (e.g., roof/slab clipping)
/// - UNION: Combines two solids into one
/// - INTERSECTION: Returns the overlapping volume of two solids
///
/// Performance notes:
/// - HalfSpaceSolid clipping is very fast (simple plane-based triangle clipping)
/// - Solid-solid CSG only invoked when actually needed (no overhead for simple geometry)
/// - Graceful fallback to first operand if CSG fails on degenerate meshes
pub struct BooleanClippingProcessor {
    pub(crate) schema: IfcSchema,
    /// Boolean failures recorded by this processor (the silent solid-solid
    /// skip, the polygonal-bounded half-space fallthrough, unknown operators)
    /// and drained from any internal `ClippingProcessor` instances. Drainable
    /// via [`Self::take_failures`].
    pub(crate) effects: NumericalEffects,
    /// Per-build small-cut skip (#1286). When set, a solid-solid DIFFERENCE
    /// whose cutter is far smaller than its host is dropped (host rendered
    /// un-cut) even at a full tessellation tier. Scoped to this processor
    /// instance — injected by the [`crate::router::GeometryRouter`] that
    /// constructs it — so concurrent native builds never bleed the flag into
    /// each other (was a process-wide static). `false` ⇒ every cut runs,
    /// byte-identical to before the optimization.
    pub(crate) skip_small_cuts: bool,
}

impl BooleanClippingProcessor {
    pub fn new() -> Self {
        Self::with_skip_small_cuts(false)
    }

    /// Construct with the per-build small-cut skip set (see
    /// [`Self::skip_small_cuts`]). The router injects the build's value here;
    /// nested boolean operands reuse the same `self`, and the only cross-
    /// processor CSG entry forwards its policy to the shared continuation,
    /// so a whole CSG tree shares one scoped value.
    pub fn with_skip_small_cuts(skip_small_cuts: bool) -> Self {
        Self {
            schema: IfcSchema::new(),
            effects: NumericalEffects::default(),
            skip_small_cuts,
        }
    }

    /// Execute the canonical owned continuation with contextual path/budget
    /// admission. Source needs remain demand-driven; numerical operations use
    /// the shared owned constructor and cutter plans.
    pub(crate) fn process_with_depth(
        &self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        _schema: &IfcSchema, depth: u32, quality: TessellationQuality,
        visited: &mut OperandPath,
    ) -> Result<(Mesh, bool)> {
        self.execute_boolean(entity, decoder, depth, quality, visited)
    }
}

impl Default for BooleanClippingProcessor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod halfspace_cap_tests;

#[cfg(test)]
mod chain_cycle_tests;

#[cfg(test)]
mod continuation_tests;
