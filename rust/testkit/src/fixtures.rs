// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Catalogued-fixture resolution (`tests/models/**`).
//!
//! Catalogued fixtures are not committed (`tests/models/manifest.json`), so a
//! test that needs one skips when it is absent. A skip is invisible in
//! `cargo test` output, which is issue #2802: a passing skip-shaped test looks
//! the same as one that asserted something. `IFC_LITE_REQUIRE_FIXTURES=1`
//! (set by CI after `pnpm fixtures`) turns every skip into a panic.
//!
//! [`fixture_bytes`] and [`fixture_text`] are the one decision point:
//!
//! | outcome                        | gate off      | gate on (`=1`) |
//! |--------------------------------|---------------|----------------|
//! | file present                   | `Some`        | `Some`         |
//! | `NotFound`                     | `None` (skip) | panic          |
//! | Git LFS pointer (not fetched)  | `None` (skip) | panic          |
//! | any other I/O error / bad UTF-8 | panic        | panic          |
//!
//! The gate value is parsed strictly: only unset, `""`, `"0"` (off) and `"1"`
//! (on) are accepted; anything else (`true`, `yes`, a typo) panics, because
//! guessing "off" would recreate the silent-pass failure.

use std::env::VarError;
use std::path::PathBuf;

/// Why a fixture could not be returned (the pure decision, see [`classify`]).
#[derive(Debug, PartialEq, Eq)]
pub enum FixtureError {
    /// The file does not exist (fixture not fetched).
    NotFound,
    /// The file is a Git LFS pointer, not the real bytes.
    LfsPointer,
}

/// The repository root, derived from this crate's location (`rust/testkit`).
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Absolute path of the catalogued fixture `rel` (relative to `tests/models/`).
pub fn fixture_path(rel: &str) -> PathBuf {
    repo_root().join("tests/models").join(rel)
}

/// Parse `IFC_LITE_REQUIRE_FIXTURES`, failing closed on the config itself.
pub fn require_fixtures() -> bool {
    require_fixtures_from(std::env::var("IFC_LITE_REQUIRE_FIXTURES"))
}

/// The pure decision behind [`require_fixtures`]; a parameter so tests need
/// not mutate the process environment (tests run on shared threads).
pub fn require_fixtures_from(var: Result<String, VarError>) -> bool {
    match var {
        Err(VarError::NotPresent) => false,
        Ok(v) if v.is_empty() || v == "0" => false,
        Ok(v) if v == "1" => true,
        other => panic!(
            "IFC_LITE_REQUIRE_FIXTURES={other:?} is not recognised (use \"1\" or \"0\") -- \
             refusing to guess, because guessing \"off\" would silently disable the gate"
        ),
    }
}

/// True when `bytes` is a Git LFS pointer file. Built at runtime so this
/// source never contains the literal marker line itself.
fn is_lfs_pointer(bytes: &[u8]) -> bool {
    let marker = format!("version {}{}", "https://git-lfs.github.com/", "spec/");
    bytes.starts_with(marker.as_bytes())
}

/// Classify a read result. `Ok(Ok(bytes))` is a usable fixture, `Ok(Err(_))`
/// a skippable absence, and a hard I/O error panics.
pub fn classify(
    rel: &str,
    read: std::io::Result<Vec<u8>>,
) -> Result<Vec<u8>, FixtureError> {
    match read {
        Ok(bytes) if is_lfs_pointer(&bytes) => Err(FixtureError::LfsPointer),
        Ok(bytes) => Ok(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(FixtureError::NotFound),
        Err(e) => panic!("fixture {rel} exists but could not be read: {e}"),
    }
}

/// Apply the gate to an absence: panic when it is on, otherwise report the
/// skip on stderr and return `None`.
fn skip_or_panic<T>(rel: &str, why: &FixtureError, gate: bool) -> Option<T> {
    let what = match why {
        FixtureError::NotFound => "not present",
        FixtureError::LfsPointer => "is a Git LFS pointer, not the real bytes",
    };
    if gate {
        panic!(
            "fixture {rel} {what} and IFC_LITE_REQUIRE_FIXTURES=1 -- run `pnpm fixtures` \
             to download (sha256 in tests/models/manifest.json)"
        );
    }
    eprintln!(
        "skipping: fixture {rel} {what} -- run `pnpm fixtures` to download \
         (sha256 in tests/models/manifest.json)"
    );
    None
}

/// Decide the outcome for `rel` given an explicit gate value (testable core).
pub fn resolve_bytes(
    rel: &str,
    read: std::io::Result<Vec<u8>>,
    gate: bool,
) -> Option<Vec<u8>> {
    match classify(rel, read) {
        Ok(bytes) => Some(bytes),
        Err(why) => skip_or_panic(rel, &why, gate),
    }
}

/// Bytes of the catalogued fixture `rel` (relative to `tests/models/`), or
/// `None` to skip. See the module table for the gate semantics.
pub fn fixture_bytes(rel: &str) -> Option<Vec<u8>> {
    resolve_bytes(rel, std::fs::read(fixture_path(rel)), require_fixtures())
}

/// Whether the catalogued fixture `rel` is present, with the same gate
/// semantics as [`fixture_bytes`] (absent or an LFS pointer: `false`, or a
/// panic under the gate). Reads only the first bytes, so it is cheap for large
/// models that the caller then loads itself.
pub fn fixture_present(rel: &str) -> bool {
    use std::io::Read;
    let head = std::fs::File::open(fixture_path(rel)).and_then(|mut f| {
        let mut buf = vec![0u8; 64];
        let n = f.read(&mut buf)?;
        buf.truncate(n);
        Ok(buf)
    });
    resolve_bytes(rel, head, require_fixtures()).is_some()
}

/// [`fixture_bytes`] decoded as UTF-8 (invalid UTF-8 panics: a corrupt
/// fixture is a setup error, not an absence).
pub fn fixture_text(rel: &str) -> Option<String> {
    fixture_bytes(rel).map(|b| {
        String::from_utf8(b).unwrap_or_else(|e| panic!("fixture {rel} is not valid UTF-8: {e}"))
    })
}

/// Bind the fixture text of `$rel` or return from the enclosing test (the
/// skip). Under `IFC_LITE_REQUIRE_FIXTURES=1` a missing fixture panics.
#[macro_export]
macro_rules! fixture_text_or_skip {
    ($rel:expr) => {
        match $crate::fixture_text($rel) {
            Some(text) => text,
            None => return,
        }
    };
}

/// Bind the fixture bytes of `$rel` or return from the enclosing test.
#[macro_export]
macro_rules! fixture_bytes_or_skip {
    ($rel:expr) => {
        match $crate::fixture_bytes($rel) {
            Some(bytes) => bytes,
            None => return,
        }
    };
}
