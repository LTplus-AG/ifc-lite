// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Traversal policy for composite-curve sampling: what a walk is allowed to
//! do, independent of any IFC type. `surface.rs` is the per-type dispatch and
//! the sampling itself; nothing here knows what an `IfcPolyline` is.

use crate::{Error, Result};

/// Two consecutive composite-curve segment endpoints closer than this are the
/// same joint, so the repeat is dropped. Wider than float noise and far below
/// any real modelling distance in either mm or m.
pub(super) const SEAM_EPS: f64 = 1e-9;

/// Total nested curve visits allowed per profile sample. See [`CurveWalk`].
pub(super) const MAX_CURVE_NODES: u32 = 100_000;

/// The two bounds on one composite-curve traversal, carried together because
/// each is blind to what the other catches.
///
/// `seen` is PATH-scoped and stops cycles. The depth cap stops a long acyclic
/// CHAIN, where every insert succeeds so `seen` never fires. And `budget` stops
/// an acyclic DAG, where two segments per level double the work: nothing is
/// cyclic, so `seen` is silent, and every level is inside the depth cap, so
/// that is silent too. Measured before the budget at 2^levels points --
/// levels=16 gave 131,072 points -- with nothing malformed in the file at all.
pub(super) struct CurveWalk {
    pub(super) seen: std::collections::HashSet<u32>,
    pub(super) budget: u32,
    /// Set only when a charge is ATTEMPTED with nothing left. Distinct from
    /// `budget == 0`, which is also true after the last PERMITTED visit -- a
    /// traversal using exactly `MAX_CURVE_NODES` visits is valid and must not
    /// be reported as exhausted (CodeRabbit, #2874 review).
    pub(super) exhausted: bool,
}

impl CurveWalk {
    pub(super) fn new() -> Self {
        Self {
            seen: std::collections::HashSet::new(),
            budget: MAX_CURVE_NODES,
            exhausted: false,
        }
    }

    /// Charge one visit. Exhaustion is an ERROR rather than a truncation: a
    /// short point list returned as if complete is a wrong profile, and the
    /// caller dropping the element is the honest outcome.
    pub(super) fn spend(&mut self) -> Result<()> {
        match self.budget.checked_sub(1) {
            Some(left) => {
                self.budget = left;
                Ok(())
            }
            None => {
                self.exhausted = true;
                Err(Error::geometry(format!(
                    "Curve traversal exceeded {MAX_CURVE_NODES} nested curves"
                )))
            }
        }
    }
}
