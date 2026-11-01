// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Whole-host void-cut strategies (stage A) and the frame-local analytic
//! cut (stage B's RectFast), each statically dispatched.
//!
//! A strategy either accepts the host (a [`Cut`]) or returns `None`, leaving
//! the host untouched for the next one. Each owns its flag gate and the
//! diagnostics it records on acceptance; nothing is recorded on a miss.

use super::VoidContext;
use crate::program::openings::execute::Execution;
use crate::Mesh;

mod bool2d;
pub(super) mod exact;
mod param_rect;
mod prism;
pub(super) mod rect_fast;

/// A whole-host strategy, tried on the host as it reached
/// [`Execution::apply_void_context`], before any frame change.
#[derive(Clone, Copy)]
pub(super) enum HostStage {
    ParamRect,
    Bool2d,
    Prism,
}

/// THE order of stage A, and the only place it is written down. The first
/// stage that accepts the host ends the stage; a later one never sees it.
/// Reordering this list changes which cut a host gets, and so its geometry
/// and diagnostics: it is a determinism-contract change, not a refactor
/// (`docs/architecture/mesh-determinism.md`).
pub(super) const HOST_STAGES: [HostStage; 3] = [HostStage::ParamRect, HostStage::Bool2d, HostStage::Prism];

/// An accepted whole-host cut. `residual` holds the openings the strategy
/// left for the exact chain, recursed only after the strategy accepted.
pub(super) struct Cut {
    pub(super) mesh: Mesh,
    pub(super) residual: Option<VoidContext>,
}

impl HostStage {
    pub(super) fn try_cut(self, execution: &Execution, host: &Mesh, ctx: &VoidContext, element_id: u32) -> Option<Cut> {
        match self {
            Self::ParamRect => param_rect::try_cut(execution, host, ctx),
            Self::Bool2d => bool2d::try_cut(execution, host, ctx, element_id),
            Self::Prism => prism::try_cut(execution, host, ctx, element_id),
        }
    }
}
