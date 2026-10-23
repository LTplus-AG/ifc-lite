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

/// The fixture for the `rect_param_*` measurement tools: `MEASURE_FIXTURE=<path>`
/// (an explicit user-supplied file, absent means skip) or else the catalogued
/// `wall-with-opening-and-window.ifc` through the gate. Returns `(label, text)`.
#[allow(dead_code)]
pub fn measure_fixture() -> Option<(String, String)> {
    const DEFAULT: &str = "buildingsmart/wall-with-opening-and-window.ifc";
    match std::env::var("MEASURE_FIXTURE") {
        Ok(path) => match std::fs::read_to_string(&path) {
            Ok(text) => Some((path, text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                eprintln!("skipping: fixture {path} not present");
                None
            }
            Err(e) => panic!("fixture {path} could not be read: {e}"),
        },
        Err(_) => ifc_lite_testkit::fixture_text(DEFAULT).map(|t| (DEFAULT.to_string(), t)),
    }
}
