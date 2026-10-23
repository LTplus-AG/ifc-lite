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
//! Canonical encoding, fingerprints, keyed comparison, content matching,
//! split/merge, successors, lineage and sidecar wire records are implemented.
//! The composed comparison entry point is [`engine::diff_models`].

pub mod fingerprint;
pub mod input;
pub mod model;
pub mod engine;
pub mod key_diff;
pub mod geometry_compare;
pub mod mutual_nearest;
pub mod content_types;
mod content_helpers;
pub mod content_match;
pub mod split_evidence;
pub mod split_geometry;
pub mod split_grid;
pub mod class_families;
pub mod split_types;
mod split_lanes;
pub mod split_merge;
pub mod successor;
pub mod identity_map;
pub mod lineage;
mod sidecar_json;
pub mod sidecar;
pub mod sidecar_validation;
pub mod sidecar_document;

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

#[cfg(test)]
mod content_tests;

#[cfg(test)]
mod split_geometry_tests;

#[cfg(test)]
mod split_merge_tests;

#[cfg(test)]
mod lineage_tests;

mod sidecar_parse;
