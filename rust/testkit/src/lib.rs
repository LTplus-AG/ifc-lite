// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Test-only helpers shared by the ifc-lite crates' test suites.
//!
//! * [`fixtures`]: catalogued-fixture resolution that honours
//!   `IFC_LITE_REQUIRE_FIXTURES` (the single home of that policy).
//! * [`step`]: an in-memory STEP file builder.
//! * [`mesh`]: mesh oracles over raw `positions` / `indices` slices.
//!
//! This crate is `publish = false` and std-only. Depend on it as a
//! path-only `[dev-dependencies]` entry (`ifc-lite-testkit = { path =
//! "../testkit" }`, no `version`) so cargo strips it when packaging and the
//! publish order is unaffected.

pub mod fixtures;
pub mod mesh;
pub mod step;

pub use fixtures::{
    fixture_bytes, fixture_path, fixture_present, fixture_text, local_fixture_text, repo_root, require_fixtures, FixtureError,
};
pub use step::step_file;
