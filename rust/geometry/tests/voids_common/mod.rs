// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared helpers for the void-subtraction test suites
//! (`voids_inline_matrix_test`, `voids_submesh_test`,
//! `voids_production_test`).
//!
//! Standard `tests/common`-style subdirectory module: Cargo does NOT
//! compile this directory as its own integration-test crate; each test
//! file pulls it in with `mod voids_common;`.

// Each test crate only uses a subset of these helpers.
#![allow(dead_code)]

pub mod fixtures;
pub mod production;
