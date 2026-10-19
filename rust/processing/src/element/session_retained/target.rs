// SPDX-License-Identifier: MPL-2.0
//! Private selected projections, never a second executor or acceptance engine.
#[cfg(not(target_arch = "wasm32"))]
#[path = "target_native.rs"]
mod selected;
#[cfg(target_arch = "wasm32")]
#[path = "target_browser.rs"]
mod selected;
pub(super) use selected::*;
