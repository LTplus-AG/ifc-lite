// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared fixture access for this crate's tests.
//!
//! Catalogued fixtures under `tests/models/` are not committed (see
//! `tests/models/manifest.json`), so a test that needs one must SKIP when it is
//! absent rather than throw or panic (AGENTS.md). Eleven modules here had each
//! grown their own `fixture()` helper that did the opposite -- `unwrap_or_else(|e|
//! panic!(...))` -- which turned a plain `cargo test --workspace` on a fresh
//! checkout into 38 failures that look like real defects. Three of the eleven had
//! separately grown a correct `fixture_opt` beside the panicking one, so both
//! behaviours shipped side by side in the same file.
//!
//! This is the one place that decides. Use [`fixture_or_skip!`] from a test.

/// Bytes of the catalogued fixture at `rel` (relative to `tests/models/`), or
/// `None` when it has not been fetched.
///
/// `None` means **`NotFound` specifically**, never "unreadable". A permission
/// error, a directory where a file belongs, or any other I/O failure is a broken
/// fixture setup, not an unfetched fixture, and it panics: treating those as
/// absence would let a whole crate's tests skip while CI reported green, which
/// is the exact failure mode this module exists to remove.
pub(crate) fn fixture_opt(rel: &str) -> Option<Vec<u8>> {
    let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
    match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping: fixture {rel} not present — run `pnpm fixtures` to download (sha256 in tests/models/manifest.json)"
            );
            None
        }
        Err(e) => panic!("fixture {rel} exists but could not be read: {e}"),
    }
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
