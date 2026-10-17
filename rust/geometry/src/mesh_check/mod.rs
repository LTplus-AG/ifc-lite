// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `mesh_check`: the one home for "is this triangle soup closed, paired,
//! manifold, and how much does it enclose".
//!
//! Before this module each gate hand-rolled its own edge-pairing hash walk, with
//! its own vertex key and its own degenerate rule. [`EdgeLedger`] is that walk
//! once; every verdict here is a named query on it. **No gate changed its key or
//! its rule**: the spellings are arguments ([`VertexKey`], [`Degenerate`]), so a
//! gate that welds at 0.1 mm still does, and one that needs exact bits still
//! does. Keys are exact or grid-quantised, and the answers are independent of
//! triangle order.
//!
//! # "Watertight"
//!
//! New code and tests mean one thing by it ([`is_watertight`]): vertices on the
//! 0.1 mm grid (`GridDiv(1e-4)`), triangles that collapse on the grid skipped,
//! every remaining edge used exactly once in each direction, and at least one
//! edge. The existing gate verdicts are deliberately different questions:
//!
//! | Verdict | Key | Degenerate | Rule |
//! |---|---|---|---|
//! | [`directed_closed`] | `GridDiv(1e-4)` | skip triangle | every edge nets to zero |
//! | [`closed_or_hairline`] | `GridDiv(1e-4)` | skip triangle | zero net, or a bounded T-junction chain |
//! | [`edge_multiplicity_defects`] | `BitsZeroFolded` | skip triangle | uses per undirected edge |
//! | `directed_closed_exact` | `Bits` | reject | every edge nets to zero |
//! | `undirected_defect_count` | `GridDiv(1e-4)` | skip triangle | uses per undirected edge |
//! | `strictly_paired_at(k)` | `GridMul(k)` | skip triangle | exactly one use each way |
//!
//! Unifying those is a policy change, not a refactor, and is not done here.
//!
//! The module is `pub(crate)`, and `pub` under the `test-support` feature so
//! the shared test oracles can delegate to it.

mod closure;
mod hairline;
mod ledger;
mod volume;

#[cfg(test)]
mod closure_tests;

// Not every re-export has a caller in every feature set (the shared oracles and
// the manifold gate are opt-in).
#[allow(unused_imports)]
pub use closure::{
    closed_enough_to_emit, closed_or_hairline, directed_closed, directed_closed_exact,
    edge_multiplicity_defects, is_watertight, strictly_paired_at, undirected_defect_count,
    ClosureVerdict, EdgeMultiplicityDefects,
};
pub use ledger::{Degenerate, EdgeLedger, Key3, VertexKey};
pub use volume::{signed_volume, signed_volume_about, volume_reference};
