// SPDX-License-Identifier: MPL-2.0
//! Enclosure is a computation hint, never geometry (#7955, #7688).
//! The Round 2 sequencing ruling delegates the whole outcome to the plane
//! path, including CUT-0's refusal until M5 qualifies plain-plane clipping.
pub(super) fn step(ctx: super::Context<'_, '_>) -> crate::Result<super::CutterStep> {
    super::plane::step(ctx)
}
