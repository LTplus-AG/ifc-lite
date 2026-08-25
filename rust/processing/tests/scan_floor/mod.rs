// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared source-tree walk and its anti-vacuity floor, for the two gates in
//! this crate that grep the tree and assert they found nothing wrong
//! (`module_size_ratchet`, `styling_parity`) — #3200.
//!
//! Standard `tests/<name>/mod.rs` subdirectory module, as
//! `rust/geometry/tests/voids_common/` already uses: Cargo does NOT compile
//! this directory as its own integration-test crate; each test file pulls it in
//! with `mod scan_floor;`.
//!
//! WHY THIS IS SHARED RATHER THAN COPIED. `repo_root` and `collect_rs_files`
//! were already byte-identical in both files, and #3200 was about to add the
//! same measurement (593 `.rs` under `rust/`, 66 under `apps/`) and the same
//! derived floors to both, in two different shapes. Two copies of one number
//! held together only by prose is how the number goes stale in one of them:
//! whoever raises the floor when `apps/` grows has no way to learn the other
//! exists. One home, one measurement, one place to edit.

#![allow(dead_code)]

/// Lower bounds on how many `.rs` files each tree must yield.
///
/// Measured on a healthy tree: 593 under `rust/`, 66 under `apps/`. Set to
/// roughly a third of each, so ordinary churn never edits this while every way
/// the walk goes blind still trips it — a failed `read_dir` returns silently
/// and a wrong scan root collapses a count to 0, not to just under its floor.
///
/// Per TREE rather than over the union, for the reason `check-lint-ran.mjs`
/// states in prose: a single floor over the combined result cannot see one tree
/// disappear behind the other. `apps/` is the small one and therefore the one a
/// union floor would hide.
pub const MIN_RS_FILES: &[(&str, usize)] = &[("rust", 190), ("apps", 20)];

/// Repo root = first ancestor holding both `rust/` and `apps/`. `None` in a
/// packaged/standalone context (the caller then skips).
pub fn repo_root() -> Option<std::path::PathBuf> {
    let mut dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf();
    loop {
        if dir.join("rust").is_dir() && dir.join("apps").is_dir() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

pub fn collect_rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let skip = matches!(
                path.file_name().and_then(|n| n.to_str()),
                Some("target" | "node_modules" | ".git" | "dist" | "build")
            );
            if !skip {
                collect_rs_files(&path, out);
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

/// Walk every tree in [`MIN_RS_FILES`] and refuse a result that came from a tree
/// this never read.
///
/// Both callers used to assert only that they found nothing WRONG, and zero
/// files scanned gives zero offenders gives green. Every path there is silent:
/// `collect_rs_files` returns on a failed `read_dir`, the callers `continue`
/// past a file they cannot read, and a missing repo root skips outright. Nothing
/// noticed the walk had gone blind, and `grep` for a length assertion in either
/// file returned nothing before #3200.
pub fn collect_with_floor(root: &std::path::Path, what: &str) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    for (top, floor) in MIN_RS_FILES {
        let before = files.len();
        collect_rs_files(&root.join(top), &mut files);
        let found = files.len() - before;
        assert!(
            found >= *floor,
            "{what} walked {top}/ and found {found} .rs file(s), expected at least {floor}. \
             Refusing to report a clean result over a tree it never read — nothing found is not \
             nothing wrong, the SCAN is wrong. If files were genuinely removed, lower this \
             tree's entry in MIN_RS_FILES in the same commit."
        );
    }
    files
}

/// The name declared by a Rust `fn` line, if it declares one.
///
/// ONE matcher, used by the source-grep guards for BOTH halves of their job:
/// finding a forbidden declaration, and proving on the same run that the
/// matcher can still find a declaration that is known to be there (#3200).
///
/// The positive control must run through THIS function rather than its own
/// copy of the same `starts_with` shape. A control with a private copy passes
/// against itself while the shipped matcher goes blind — the exact failure it
/// exists to catch, and structurally invisible to it. Widening this (an
/// `async fn`, an attribute on the same line, a different trim) then moves both
/// halves together, which is the point.
pub fn declared_fn_name(line: &str) -> Option<&str> {
    let line = line.trim_start();
    let rest = line
        .strip_prefix("pub(crate) fn ")
        .or_else(|| line.strip_prefix("pub fn "))
        .or_else(|| line.strip_prefix("fn "))?;
    let end = rest
        .find(|c: char| !c.is_alphanumeric() && c != '_')
        .unwrap_or(rest.len());
    Some(&rest[..end])
}
