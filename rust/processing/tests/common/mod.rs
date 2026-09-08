// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared helper for the source-walking CI gates in this crate
//! (`module_size_ratchet`, `styling_parity`).
//!
//! Lives here rather than being copied into each test binary so the rule has
//! ONE implementation: two copies of a gate's escape hatch are two chances to
//! loosen one of them and not the other.

/// Refuse to skip a source-walking gate when running under CI.
///
/// Both gates begin `let Some(root) = repo_root() else { eprintln!(…); return; }`.
/// That early return is the widest hole the #3200 hardening left open: it
/// happens BEFORE the walk, so it bypasses the missing-root panic, the
/// unreadable-file panic and the scan floor all at once. Reproduced with
/// `repo_root` stubbed to `None` — `no_module_grows_past_its_ratchet_budget`,
/// `no_duplicate_default_color_tables` and
/// `no_duplicate_surface_style_color_extraction` each report
/// `ok … finished in 0.00s`: three green gates over a tree never opened.
///
/// It cannot simply become a panic. `tests/` is packaged into the published
/// `.crate` (there is no `exclude` in `rust/processing/Cargo.toml`), so a
/// downstream `cargo test` on `ifc-lite-processing` runs these files with no
/// `rust/` or `apps/` above them, and skipping is correct there. Nor can the
/// two situations be told apart by looking for the repo — its absence is the
/// thing being explained.
///
/// `CI` is the discriminator: GitHub Actions sets it on every run, and a
/// packaged consumer's machine does not have it. The truthiness test follows
/// the form already used by `rust/geometry/tests/triangulation_invariance.rs`
/// rather than inventing a second convention for the same variable.
pub fn refuse_to_skip_in_ci(gate: &str) {
    let ci = std::env::var_os("CI").is_some_and(|v| !v.is_empty() && v != "0" && v != "false");
    assert!(
        !ci,
        "{gate}: no repo root above CARGO_MANIFEST_DIR ({}), but CI is set. Under CI \
         this gate must scan the tree, not skip it — skipping bypasses the \
         missing-root panic, the unreadable-file panic AND the scan floor at once, \
         and reports success over a tree that was never opened (#3200). Either the \
         checkout is incomplete or the walk roots are wrong; both block a release, \
         and neither of them means 'no offenders'.",
        env!("CARGO_MANIFEST_DIR")
    );
}
