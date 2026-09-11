// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared `IFC_LITE_REQUIRE_FIXTURES` handling for `rust/geometry`'s
//! fixture-backed integration tests.
//!
//! `rust/export/src/test_support.rs` is the canonical home for this
//! convention, but it is private to the export crate and unreachable from
//! here; `rust/processing/tests/issue_3821_boolean_failure_drain.rs`
//! duplicates the same parse locally for the same reason. This module is
//! that same duplication, shared across `rust/geometry`'s integration test
//! binaries (each `tests/*.rs` file is its own crate, so a `mod support;`
//! import is required, but the parse logic itself must match byte-for-byte
//! — see [`require_fixtures`]).
//!
//! Unset, empty, or `"0"` means "off" (skip a missing fixture — the
//! historical default, unaffected by this module). `"1"` means "on": a
//! missing fixture becomes a hard `panic!` instead of a skip. The
//! `csg-accept-gates` CI job sets `IFC_LITE_REQUIRE_FIXTURES=1` after an
//! unconditional `Verify fixtures` step, so on a correct run this costs
//! nothing and turns fixture drift into a loud failure instead of a
//! quietly-smaller test suite (issue #2802's failure mode: a passing
//! skip-shaped test is indistinguishable, in the only output anyone reads,
//! from one that actually asserted something). An unrecognised value (e.g.
//! `true`, `yes`, a typo) PANICS rather than falling through to "off":
//! guessing "off" for a misconfigured gate would recreate exactly the
//! silent-pass problem this module exists to close.

/// Parse `IFC_LITE_REQUIRE_FIXTURES`, failing closed on the config itself.
#[allow(dead_code)]
pub fn require_fixtures() -> bool {
    match std::env::var("IFC_LITE_REQUIRE_FIXTURES") {
        Err(std::env::VarError::NotPresent) => false,
        Ok(v) if v.is_empty() || v == "0" => false,
        Ok(v) if v == "1" => true,
        other => panic!(
            "IFC_LITE_REQUIRE_FIXTURES must be unset, \"\", \"0\" or \"1\"; got {other:?}"
        ),
    }
}
