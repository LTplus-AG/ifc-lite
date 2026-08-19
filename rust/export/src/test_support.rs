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
//!
//! A skip here is a real `eprintln!`, but `cargo test` captures stdout/stderr
//! for a test that passes and only releases the buffer on failure -- so on a
//! plain `cargo test` (no `--nocapture`) the skip message is written and then
//! thrown away, and the only trace of it is the test showing `ok` like every
//! other one. That is issue #2802: a passing `fixture_or_skip!` test looks
//! identical, in the only output anyone reads, to one that actually asserted
//! something. `IFC_LITE_REQUIRE_FIXTURES=1` closes that for CI: with it set,
//! a missing fixture is a hard `panic!` (a real failure, never captured away)
//! instead of a skip. CI already runs `pnpm fixtures` before `cargo test`, so
//! setting this var there costs nothing on a correct run and turns fixture
//! drift into a loud failure instead of a quietly-smaller test suite. Unset
//! (the default), behavior is unchanged: a fixture-less local `cargo test` is
//! still a legitimate, silently-skipping workflow.
//!
//! The value is parsed strictly (see [`require_fixtures`]): only `"1"` turns
//! the gate on and only unset/empty/`"0"` leave it off. An unrecognised value
//! -- `true`, `yes`, `TRUE` -- panics instead of being treated as either,
//! because falling through to "off" for a typo would recreate exactly the
//! silent-pass problem this module exists to close.

/// Parse `IFC_LITE_REQUIRE_FIXTURES`, failing closed on the config itself.
///
/// Unset, empty, or `"0"` means "off" (the historical default: skip). `"1"`
/// means "on". Anything else -- `true`, `yes`, `TRUE`, a typo -- panics rather
/// than being treated as either value. A `== Ok("1")` check that let
/// unrecognised strings fall through to "off" would land the misconfiguration
/// on the permissive side: `IFC_LITE_REQUIRE_FIXTURES=true` in a workflow file
/// would read as "gate enabled" while actually leaving every fixture test free
/// to skip, silently and indistinguishably from the gate working -- exactly
/// the failure mode this module exists to remove. Guessing "off" for an
/// unrecognised value would reproduce that; refusing to guess does not.
fn require_fixtures() -> bool {
    match std::env::var("IFC_LITE_REQUIRE_FIXTURES") {
        Err(_) => false,
        Ok(v) if v.is_empty() || v == "0" => false,
        Ok(v) if v == "1" => true,
        Ok(v) => panic!(
            "IFC_LITE_REQUIRE_FIXTURES={v:?} is not recognised (use \"1\" or \"0\") — \
             refusing to guess, because guessing \"off\" would silently disable the gate"
        ),
    }
}

/// Bytes of the catalogued fixture at `rel` (relative to `tests/models/`), or
/// `None` when it has not been fetched.
///
/// `None` means **`NotFound` specifically**, never "unreadable". A permission
/// error, a directory where a file belongs, or any other I/O failure is a broken
/// fixture setup, not an unfetched fixture, and it panics: treating those as
/// absence would let a whole crate's tests skip while CI reported green, which
/// is the exact failure mode this module exists to remove.
///
/// When `IFC_LITE_REQUIRE_FIXTURES=1` is set, a missing fixture panics too --
/// see the module doc. Unset, empty, or `"0"` keeps the skip. Any other value
/// (e.g. `true`, `yes`, a typo) is itself a hard error -- see
/// [`require_fixtures`].
pub(crate) fn fixture_opt(rel: &str) -> Option<Vec<u8>> {
    let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
    match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if require_fixtures() {
                panic!(
                    "fixture {rel} not present and IFC_LITE_REQUIRE_FIXTURES=1 — run `pnpm fixtures` to download (sha256 in tests/models/manifest.json)"
                );
            }
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
