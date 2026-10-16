// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Ratchet: no Rust test file may read a catalogued fixture (`tests/models/**`)
//! without going through the `IFC_LITE_REQUIRE_FIXTURES` gate (issue #2802:
//! a skip-shaped test that passes without asserting anything).
//!
//! A file is flagged when a non-comment line names `tests/models` AND the file
//! calls `read_to_string(` / `fs::read(`, yet the file never mentions the gate
//! (`ifc_lite_testkit`, `require_fixtures`, `REQUIRE_FIXTURES`, `fixture_opt`,
//! `fixture_or_skip`). Use `ifc_lite_testkit::fixture_text` / `fixture_bytes`.
//!
//! `UNGATED` is a debt list: it may only shrink. A file that is fixed must be
//! removed (the second test fails on a stale entry), and a new offender must
//! use the testkit instead of being added here.

use std::path::{Path, PathBuf};

/// Files that still read `tests/models` without the gate, with why.
const UNGATED: &[(&str, &str)] = &[
    // Private, un-manifested local models: `pnpm fixtures` cannot supply them.
    ("rust/geometry/tests/ar_wall_test.rs", "private local model, #[ignore]d"),
    ("rust/geometry/tests/test_infra_rtc.rs", "private tests/models/local corpus"),
    // Measurement tools / census sweeps driven by env or by the manifest.
    ("rust/geometry/tests/rect_param_census.rs", "MEASURE_FIXTURE profiling tool"),
    ("rust/geometry/tests/rect_param_parity.rs", "measurement tool"),
    ("rust/geometry/tests/rect_param_production.rs", "measurement tool"),
    ("rust/geometry/tests/issue_3440_manifold_gate_census.rs", "manifest-driven census"),
    ("rust/geometry/tests/issue_3440_topology_gate_census.rs", "manifest-driven census"),
    // Not folded in the testkit PR (D9: fold only when touched); follow-ups.
    ("rust/processing/tests/analytic_swept_disk.rs", "follow-up"),
    ("rust/geometry/src/alignment_sampling_tests.rs", "open PR #7752 touches it"),
    ("apps/server/src/services/data_model/tests.rs", "open PR #7752 touches it"),
];

fn repo_root() -> PathBuf {
    ifc_lite_testkit::repo_root()
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            // `examples/` are manual measurement tools, not tests.
            let skip = matches!(&*name, "target" | "node_modules" | "testkit" | "examples");
            if !skip && !name.starts_with('.') {
                rust_files(&path, out);
            }
        } else if name.ends_with(".rs") {
            out.push(path);
        }
    }
}

fn is_comment(line: &str) -> bool {
    line.trim_start().starts_with("//")
}

fn reads_ungated(src: &str) -> bool {
    let names_models = src.lines().any(|l| !is_comment(l) && l.contains("tests/models"));
    let reads = src.contains("read_to_string(") || src.contains("fs::read(");
    let gated = ["ifc_lite_testkit", "require_fixtures", "REQUIRE_FIXTURES", "fixture_opt", "fixture_or_skip"]
        .iter()
        .any(|g| src.contains(g));
    names_models && reads && !gated
}

fn offenders() -> Vec<String> {
    let root = repo_root();
    let mut files = Vec::new();
    for sub in ["rust", "apps"] {
        rust_files(&root.join(sub), &mut files);
    }
    let mut hits: Vec<String> = files
        .iter()
        .filter(|p| std::fs::read_to_string(p).map(|s| reads_ungated(&s)).unwrap_or(false))
        .map(|p| p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"))
        .collect();
    hits.sort();
    hits
}

#[test]
fn no_new_test_reads_a_catalogued_fixture_without_the_gate() {
    let allowed: Vec<&str> = UNGATED.iter().map(|(p, _)| *p).collect();
    let new: Vec<String> = offenders().into_iter().filter(|p| !allowed.contains(&p.as_str())).collect();
    assert!(
        new.is_empty(),
        "these files read tests/models without IFC_LITE_REQUIRE_FIXTURES (a missing fixture \
         would skip silently in CI, #2802); use ifc_lite_testkit::fixture_text / fixture_bytes: {new:#?}"
    );
}

#[test]
fn the_ungated_debt_list_has_no_stale_entries() {
    let found = offenders();
    let stale: Vec<&str> = UNGATED.iter().map(|(p, _)| *p).filter(|p| !found.iter().any(|f| f == p)).collect();
    assert!(stale.is_empty(), "fixed (or removed) files still listed in UNGATED, delete them: {stale:#?}");
}

#[test]
fn the_detector_flags_a_raw_read_and_accepts_a_gated_one() {
    let raw = "const F: &str = \"../../tests/models/x.ifc\";\nfn r() { let _ = std::fs::read_to_string(F); }\n";
    assert!(reads_ungated(raw));
    let gated = format!("{raw}// ifc_lite_testkit::fixture_text\n");
    assert!(!reads_ungated(&gated));
    assert!(!reads_ungated("// tests/models in a comment\nfn r() { std::fs::read(\"a\"); }\n"));
}
