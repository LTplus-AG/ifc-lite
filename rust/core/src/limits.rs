// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bounds on walks over file-supplied entity references, and the rule for
//! choosing between them.
//!
//! # Why a walk over file references needs a bound at all
//!
//! Entity references come from the file, so their shape is attacker- and
//! exporter-controlled. `#10=IFCBOOLEANRESULT(.DIFFERENCE.,#10,#20)` is one
//! self-referential entity, and an unbounded recursive walk over it consumes a
//! stack frame per hop until the process dies. In Rust that death is a
//! `SIGABRT`, not a catchable panic: nothing upstream can turn it into a load
//! error, and in the wasm geometry worker it takes down the whole instance.
//! #2866 found seven such sites, two of them reachable from uploaded bytes or
//! from any file opened in the browser.
//!
//! # Choosing the bound: by what the walk RETURNS, not by how it traverses
//!
//! The three mechanisms are not interchangeable, and each one alone leaves a
//! real hole:
//!
//! - a **depth cap** bounds one path's LENGTH. It does not bound breadth: `k`
//!   items each leading back into a cycle costs `O(k^depth)`, which converts an
//!   abort into a hang. Measured at 7.21s for k=3 in #2864, and a hang is worse
//!   than a crash because nothing reports it.
//! - a **visited set** bounds cycles and revisits. While the walk still
//!   recurses it does NOT bound a long *acyclic* chain: every insert succeeds,
//!   the set never fires, and the stack still overflows (verified at 200k links).
//! - a **work budget** bounds acyclic DAG fan-out, which neither of the others
//!   sees. An acyclic graph where every branch succeeds never errors and never
//!   repeats an id; it just emits 2^levels outputs.
//!
//! Pick the visited set's SCOPE by what the walk produces:
//!
//! - **global / memoising** when the result is a pure function of the id. A
//!   colour is determined by (item id, style map), so an id that resolved once
//!   cannot resolve differently down another branch. Global is safe here and
//!   strictly stronger: it kills fan-out outright.
//! - **path-scoped** (insert on the way in, remove on the way out) when output
//!   ACCUMULATES. A boolean operand tree is a DAG and geometry accumulates, so
//!   the same node reached down two branches is two real pieces of geometry. A
//!   global set silently drops the second: **missing geometry, not a cycle
//!   guard**, and no test that only checks termination will notice.
//!
//! Getting this backwards fails silently in both directions, which is why the
//! rule is written down rather than left to be re-derived per site.
//!
//! # Prefer iterating over capping
//!
//! If the walk can be made iterative, do that instead of adding a length cap:
//! with no stack to consume there is nothing left for a cap to protect, and the
//! visited set becomes sufficient on its own. A cap chosen to stop a cycle is
//! usually tight enough to reject legitimate input — #960 records Revit
//! exports with `FirstOperand` chains 42 `DIFFERENCE` nodes deep, and a walk
//! capped below that returns "no" for a file that renders correctly today.
//!
//! # Pin the guard, not just the behaviour
//!
//! A guard that both ACTS and REPORTS has a two-part contract: bound the work,
//! AND report that you bounded it. Mutate the halves separately — they fail
//! differently, a missing bound hangs and a missing report returns a truncated
//! success. Several guards added under #2866 were initially unpinned: deleting
//! a visited set left 693 tests green because a depth cap was covering for it,
//! and a long-chain test asserted `false`, a value both "bailed early" and
//! "walked correctly" produce.

/// Maximum `IfcMappedItem` → `IfcRepresentationMap` → `MappedRepresentation.Items`
/// nesting any walk in this workspace will follow.
///
/// Shared because three crates walk the SAME chain and their bounds must agree:
/// `ifc_lite_processing::element`, `ifc_lite_geometry::router::processing` and
/// `ifc-lite-wasm`'s styling colour resolver. When they disagreed the failure
/// was silent — #2864 shipped 16 against the router's 32, so any element whose
/// chain was 17 to 32 links long still rendered its geometry and quietly lost
/// its authored colour.
///
/// A walk over this chain also needs a cycle guard; the cap alone is not
/// sufficient (see the module docs above for which kind).
pub const MAX_MAPPED_ITEM_DEPTH: u32 = 32;

#[cfg(test)]
mod tests {
    use super::*;

    /// The documented contract. This pins the VALUE; the constant being shared
    /// is what pins agreement between the three walks, and that is now
    /// structural rather than asserted.
    #[test]
    fn mapped_item_depth_is_the_documented_32() {
        assert_eq!(MAX_MAPPED_ITEM_DEPTH, 32);
    }
}
