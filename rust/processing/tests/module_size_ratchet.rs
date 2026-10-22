// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Module-size ratchet: makes the AGENTS.md "split modules over ~400
//! non-generated lines" rule an actual CI gate instead of an unenforced review
//! convention (it had zero executable enforcement, so the tree accumulated 80+
//! files over the bar).
//!
//! The gate has two teeth:
//!  1. A NEW non-generated, non-test `.rs` file that crosses 400 lines and is
//!     not in `module_size_allowlist.txt` fails the build. This is the
//!     load-bearing guarantee: no new god files.
//!  2. An allowlisted file that GROWS past its recorded budget fails. Existing
//!     debt is frozen; a big file can only stay flat or shrink.
//!
//! Shrinking a file below 400 lets you delete its allowlist row (the total
//! trends down). Adding a row is allowed only with a written justification in
//! the PR. Generated code and test/example/bench/fuzz files are exempt.
//!
//! This runs in the required `rust-tests` lane (`cargo test --workspace`), so a
//! violation blocks merge. Cross-crate file walking mirrors `styling_parity`.
//!
//! ANTI-VACUITY (#3200): every offender this gate reports is produced by
//! iterating the walked file list, so an empty walk produced an empty message
//! and a green test - success reported over a tree that was never opened. Four
//! guards now stand between an empty walk and that pass: a missing or unreadable
//! scan root is a hard error instead of an empty result (and the two are told
//! apart, because they call for different fixes), a file that cannot be read is
//! a hard error instead of 0 lines, the walk must reach at least `FILE_FLOOR`
//! non-exempt files before any verdict below it counts, and under CI the
//! no-repo-root skip is refused outright (`common::refuse_to_skip_in_ci`) - that
//! skip returns before the walk, so it bypassed all three of the others at once.

mod common;
use common::source_walk::{collect_rs_files, is_exempt, repo_root};
use std::collections::BTreeMap;

const LIMIT: usize = 400;
const ALLOWLIST: &str = include_str!("module_size_allowlist.txt");

/// Digest of every `(path, budget)` pair in the allowlist, pinned HERE rather
/// than in the allowlist itself: a figure derived from the file it guards is
/// circular and always passes.
///
/// Rule 2 above ("an allowlisted file that GROWS past its recorded budget
/// fails") has an escape hatch invisible in its own output: raising the budget
/// in the SAME commit that grows the file satisfies it. That is how a raise
/// reached main and had to be undone afterwards (#2658).
///
/// A plain SUM was the first attempt and is not enough: raising one budget by
/// 100 while lowering another by 100 leaves the total unchanged, so a
/// compensating edit still slips through. The digest moves for ANY change to
/// ANY row, so loosening the ratchet always costs one reviewable line here.
///
/// FNV-1a over the sorted rows rather than `DefaultHasher`, whose output is
/// explicitly NOT guaranteed stable across Rust releases - a toolchain bump
/// would rewrite the digest and fail CI for no reason.
const ALLOWLIST_DIGESTS: &[(&str, u64)] = &[
    ("apps/server", 4104424009168246343),
    ("rust/core", 16604054656275753038),
    ("rust/export", 2156577647744325171),
    ("rust/geometry", 1016157967927945994),
    ("rust/processing", 5708093823077624517),
