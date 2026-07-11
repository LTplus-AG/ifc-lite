// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! GPU mesh parsing methods for IFC-Lite API
//!
//! Includes synchronous and async mesh parsing, instanced geometry,
//! and GPU-ready geometry generation.

mod batch;
mod batch_from_source;
mod instancing;
pub(crate) mod prepass;
mod prepass_discovery;
mod prepass_sharded;
mod void_index;
