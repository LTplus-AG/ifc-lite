// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! BooleanClipping processor - CSG operations.
//!
//! Handles IfcBooleanResult and IfcBooleanClippingResult for boolean operations
//! (DIFFERENCE, UNION, INTERSECTION).

use crate::diagnostics::BoolFailure;
use ifc_lite_core::IfcSchema;
use std::cell::RefCell;

mod bounded_prism_mesh;
mod bounded_prism_plan;
pub(crate) mod brep_void_plan;
mod brep_voids;
mod cut_heuristics;
mod failures;
mod half_space_plan;
mod polygonal_group_execution;
pub(crate) mod solid_execution;
pub(crate) mod spine_plan;
mod polygonal_chain;
mod operand;
mod halfspace_cap;
mod polygonal_boundary;
mod polygonal_prism;
mod single_cutter_gate;
mod polygonal_union;
mod polygonal_removal;
#[cfg(test)]
use halfspace_cap::cap_half_space_clip;
#[cfg(test)]
use halfspace_cap::force_cdt_fail_on_ring_for_test;

/// Maximum recursion depth for nested boolean operations.
/// Prevents stack overflow from deeply nested IfcBooleanResult chains.
/// In WASM, the stack is limited (~1-8MB), and each recursion level uses
/// significant stack space for CSG operations.
pub(crate) const MAX_BOOLEAN_DEPTH: u32 = 10;

/// Longest chain of nested boolean/CSG operand nodes on one path. Bounds the
/// stack where `MAX_BOOLEAN_DEPTH` cannot: see the program continuation's
/// `enter_boolean` (`program/boolean`).
///
/// Both boolean AND CSG nodes go into the set, so `len()` is an honest count of
/// recursion frames on the current path and this number means what it says. An
/// earlier revision counted booleans only and leaned on `IfcCsgSolid ->
/// IfcCsgSolid` being rejected elsewhere to keep the ratio bounded; see
/// the CSG hop in the program continuation (and #2866) for why that was the
/// wrong trade.
pub(crate) const MAX_OPERAND_PATH_NODES: usize = 64;

pub(crate) use operand::{boolean_operator, OperandPath, MAX_OPERAND_VISITS};
pub(crate) use bounded_prism_plan::BoundedPrismPlan;
pub(crate) use half_space_plan::HalfSpacePlan;
pub(crate) use polygonal_group_execution::GroupExecution;
pub(crate) use polygonal_prism::host_stays_on_kept_side;
pub(crate) use single_cutter_gate::SingleCutterSubtract;

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
    schema: IfcSchema,
    /// Boolean failures recorded by this processor (the silent solid-solid
    /// skip, the polygonal-bounded half-space fallthrough, unknown operators)
    /// and drained from any internal `ClippingProcessor` instances. Drainable
    /// via [`Self::take_failures`].
    failures: RefCell<Vec<BoolFailure>>,
    /// Per-build small-cut skip (#1286). When set, a solid-solid DIFFERENCE
    /// whose cutter is far smaller than its host is dropped (host rendered
    /// un-cut) even at a full tessellation tier. Scoped to this processor
    /// instance — injected by the [`crate::router::GeometryRouter`] that
    /// constructs it — so concurrent native builds never bleed the flag into
    /// each other (was a process-wide static). `false` ⇒ every cut runs,
    /// byte-identical to before the optimization.
    skip_small_cuts: bool,
}

impl BooleanClippingProcessor {
    pub fn new() -> Self {
        Self::with_skip_small_cuts(false)
    }

    /// Construct with the per-build small-cut skip set (see
    /// [`Self::skip_small_cuts`]). The router injects the build's value here;
    /// nested boolean operands reuse the same `self`, and the only cross-
    /// processor boolean construction site (`CsgSolidProcessor`) forwards its
    /// own field so a whole CSG tree shares one scoped value.
    pub fn with_skip_small_cuts(skip_small_cuts: bool) -> Self {
        Self {
            schema: IfcSchema::new(),
            failures: RefCell::new(Vec::new()),
            skip_small_cuts,
        }
    }
}

impl BooleanClippingProcessor {
    /// The schema the built-in operand processors are given.
    pub(crate) fn schema(&self) -> &IfcSchema {
        &self.schema
    }

    /// The per-build small-cut skip a solid/solid step reads.
    pub(crate) fn skip_small_cuts(&self) -> bool {
        self.skip_small_cuts
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
