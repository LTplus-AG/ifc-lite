// SPDX-License-Identifier: MPL-2.0
//! #7781: statically dispatched strategies in frozen geometry-output order.
use super::VoidContext;
use crate::program::openings::execute::Execution;
use crate::Mesh;

mod param_rect;
mod bool2d;
mod prism;

#[derive(Clone, Copy)]
pub(super) enum HostStrategy { ParamRect, Bool2d, Prism }

pub(super) const HOST_STRATEGIES: [HostStrategy; 3] = [
    HostStrategy::ParamRect, HostStrategy::Bool2d, HostStrategy::Prism,
];

/// `None` from a strategy means defer with the original host unchanged.
/// Residual openings are recursed only after the strategy has accepted its cut.
pub(super) struct Cut {
    pub(super) mesh: Mesh,
    pub(super) residual: Option<VoidContext>,
}

impl HostStrategy {
    pub(super) fn try_cut(
        self, execution: &Execution, host: &Mesh, context: &VoidContext, element_id: u32,
    ) -> Option<Cut> {
        match self {
            Self::ParamRect => param_rect::try_cut(execution, host, context),
            Self::Bool2d => bool2d::try_cut(execution, host, context, element_id),
            Self::Prism => prism::try_cut(execution, host, context, element_id),
        }
    }
}

mod rect_fast;
mod wall_local_frame;

#[derive(Clone, Copy)]
pub(super) enum InnerStrategy { WallLocalFrame, RectFast }

// Facet welding and the kernel-failure guard remain between these two attempts.
pub(super) const INNER_STRATEGIES: [InnerStrategy; 2] = [
    InnerStrategy::WallLocalFrame, InnerStrategy::RectFast,
];

impl InnerStrategy {
    pub(super) fn try_cut(
        self, execution: &Execution, host: &Mesh, context: &VoidContext, element_id: u32,
        bounds: ((f32, f32, f32), (f32, f32, f32)), triangles_before: usize,
    ) -> Option<Mesh> {
        match self {
            Self::WallLocalFrame => execution.cut_in_wall_frame(host, context, element_id, bounds),
            Self::RectFast => rect_fast::try_cut(execution, host, context, element_id, bounds, triangles_before),
        }
    }
}
