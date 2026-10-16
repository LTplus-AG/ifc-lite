// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IFC_LITE_REQUIRE_FIXTURES` handling for `rust/geometry`'s fixture-backed
//! integration tests.
//!
//! The policy (strict parse; a missing or LFS-pointer fixture panics under
//! `=1`, skips otherwise; issue #2802) has one home, `ifc-lite-testkit`
//! (`fixtures` module). Each `tests/*.rs` file is its own crate, so a
//! `mod support;` import is still needed to name it here; this module only
//! re-exports the gate parse for the tests that branch on it themselves.
//! Prefer `ifc_lite_testkit::fixture_text` / `fixture_bytes` /
//! `fixture_text_or_skip!`, which apply the gate for you.

#[allow(unused_imports)]
pub use ifc_lite_testkit::require_fixtures;
