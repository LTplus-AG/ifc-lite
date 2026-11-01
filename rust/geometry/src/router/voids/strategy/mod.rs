// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The void-cut stages after classification, each statically dispatched:
//! the whole-host strategies of stage A (`HOST_STAGES`), the frame-local
//! driver (`inner.rs`, `Execution::cut_in_frame`) with stage B's
//! WallLocalFrame and RectFast, and the exact tail (`exact`).
//!
//! A strategy either accepts the host (a [`Cut`]) or returns `None`, leaving
//! the host untouched for the next one. Each owns its flag gate and the
//! diagnostics it records on acceptance; nothing is recorded on a miss.
//!
//! Adding a strategy is one variant or one call in the place that owns the
//! order (`HOST_STAGES`, `cut_in_frame`, `ExactTail::run` or `post::finish`)
//! plus one file. Inserting it anywhere changes some host's geometry, so it
//! comes with a stage-order guard in `stage_order_tests.rs` and re-pinned
//! determinism manifests if any output moves.

use super::VoidContext;
use crate::program::openings::execute::Execution;
use crate::Mesh;

mod bool2d;
mod exact;
mod inner;
mod param_rect;
mod prism;
mod rect_fast;
mod wall_local_frame;

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
