// SPDX-License-Identifier: MPL-2.0
//! Deliberate CUT-0 refusal; its feature slice supplies the qualified operation.
pub(super) fn step(ctx: super::Context<'_, '_>) -> crate::Result<super::CutterStep> { super::refuse(ctx) }
