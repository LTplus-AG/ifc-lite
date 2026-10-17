// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared fixture access for this crate's tests.
//!
//! The policy (skip on `NotFound`, panic on other I/O errors, and turn every
//! skip into a panic under `IFC_LITE_REQUIRE_FIXTURES=1`, issue #2802) lives in
//! `ifc-lite-testkit`, shared with every other crate's tests; this module only
//! adapts it to the `fixture_opt` / [`fixture_or_skip!`] spelling used here.
//! A Git LFS pointer is treated like a missing fixture (it is not a model).

/// Bytes of the catalogued fixture at `rel` (relative to `tests/models/`), or
/// `None` when it has not been fetched. See `ifc_lite_testkit::fixture_bytes`.
pub(crate) fn fixture_opt(rel: &str) -> Option<Vec<u8>> {
    ifc_lite_testkit::fixture_bytes(rel)
}

/// Bind the fixture's bytes, or return from the enclosing test when it is absent.
///
/// The early return is the skip: Rust has no native skip, so this matches the
/// house convention already used by `processors/tests.rs`. CI always runs
/// `pnpm fixtures` first, so a skip there would be a CI-config bug, not silence.
macro_rules! fixture_or_skip {
    ($rel:expr) => {
        match $crate::test_support::fixture_opt($rel) {
            Some(bytes) => bytes,
            None => return,
        }
    };
}
