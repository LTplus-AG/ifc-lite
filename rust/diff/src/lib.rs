// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Store-agnostic entity diff engine for IFC models.
//!
//! A Rust port of `@ifc-lite/diff`, carrying the same contract: pure, no I/O,
//! no parser, no geometry kernel. Callers extract fingerprints from whatever
//! store they have and this crate compares them.
//!
//! # Byte-exactness is the contract, not just equal verdicts
//!
//! The fingerprints this crate produces must be **identical strings** to the
//! TypeScript engine's, not merely consistent within Rust. `@ifc-lite/merge`
//! consumes `stableHash` for its component snapshots, so a hash that differed
//! would surface as spurious merge conflicts rather than as a test failure.
//!
//! That is harder than it looks, because the hash is taken over
//! `JSON.stringify` output and the digest consumes UTF-16 code units. Three
//! places where the obvious Rust is wrong, each measured against V8 rather
//! than assumed:
//!
//! 1. **UTF-16 code-unit order is not codepoint order.** `"\u{E000}"` sorts
//!    *after* `"\u{10000}"` in JavaScript and *before* it in Rust. See
//!    [`utf16::cmp_code_units`].
//! 2. **ECMAScript number formatting is not Rust's `Display`.** `1e21`
//!    renders as `1e+21`, not `1000000000000000000000`. Handled by `ryu-js`.
//! 3. **`JSON.stringify` preserves key order; `stableSerialize` sorts.** Both
//!    are used, for different purposes. See [`js_json`].
//!
//! Current scope is the canonical encoding and the fingerprints. The diff
//! pass, content matching, split/merge, successors, lineage and the sidecar
//! formats follow in later changes.

pub mod fingerprint;
pub mod input;
pub mod model;
pub mod key_diff;

// Internal. The canonical encoding and the code-unit helpers are
// implementation detail of the fingerprint, not a surface worth promising:
// this crate is published, so every public item is a semver commitment. The
// one thing outside callers need is `stable_hash`, re-exported below because
// `@ifc-lite/merge` hashes component snapshots with it.
mod js_json;
mod projections;
mod utf16;

pub use fingerprint::{build_component_fingerprints, build_data_fingerprint};
pub use input::{
    DataFingerprintInput, PropertyEntryInput, PropertySetInput, PropertyValue, QuantitySetInput,
    TypeAssignmentInput,
};
pub use utf16::stable_hash;
