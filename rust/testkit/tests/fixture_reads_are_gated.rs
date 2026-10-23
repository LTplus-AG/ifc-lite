// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Ratchet: no Rust test file may read a catalogued fixture (`tests/models/**`)
//! without going through the `IFC_LITE_REQUIRE_FIXTURES` gate (issue #2802:
//! a skip-shaped test that passes without asserting anything).
//!
//! A file is flagged when its code (comments stripped) names `tests/models` --
//! however the path is spelled: `"tests/models"`, `.join("tests").join("models")`,
//! `concat!(.., "/tests/", "models")` -- AND reads or probes the filesystem
//! (`read_to_string(`, `fs::read(`, `File::open(`, `read_to_end(`, `OpenOptions`,
//! `read_dir(`, `.exists()`, `.is_file()`, `fs::metadata(`), yet never mentions
//! one of the gate-specific names (`fixture_text`, `fixture_bytes`,
//! `fixture_present`, `fixture_*_or_skip`, `fixture_opt`).
//! Neither the bare crate name nor the env-var string counts: a file can import
//! `ifc_lite_testkit::mesh` and still read raw, and a file that matches
//! `NotFound` and tests `IFC_LITE_REQUIRE_FIXTURES` itself is a second copy of
//! the policy that drifts (#7696).
//! A `.exists()` probe that then returns early is the same silent skip as a
//! `NotFound` match, so it is detected too.
//!
//! `UNGATED` is a debt list: it may only shrink. A file that is fixed must be
//! removed (the second test fails on a stale entry), and a new offender must
//! use the testkit instead of being added here.

use std::path::{Path, PathBuf};

/// Files that still read `tests/models` without the gate, with why. Empty on
/// purpose: every reader goes through `ifc_lite_testkit` (the private
/// un-manifested models through `local_fixture_text`, which is explicit about
/// never gating). Add a row only with a reason the testkit cannot serve.
const UNGATED: &[(&str, &str)] = &[];

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

/// The file's code with comment lines dropped and path-building syntax
/// flattened, so `.join("tests").join("models")` and
/// `concat!(.., "/tests/", "models")` read as `/tests/models`.
fn flattened_code(src: &str) -> String {
    let code: String = src.lines().filter(|l| !is_comment(l)).collect::<Vec<_>>().join("\n");
    let code = code.replace(".join(", "/").replace(".push(", "/").replace("concat!(", "");
    let mut out = String::with_capacity(code.len());
    for c in code.chars() {
        if !matches!(c, '"' | ',' | ' ' | '\t' | '\n' | '\r' | '(' | ')' | '+' | '&' | '[' | ']') {
            out.push(c);
        }
    }
    while out.contains("//") {
        out = out.replace("//", "/");
    }
    out
}

const READS: &[&str] = &[
    "read_to_string(",
    "fs::read(",
    "File::open(",
    "read_to_end(",
    "OpenOptions",
    "read_dir(",
    ".exists()",
    ".is_file()",
    "fs::metadata(",
];

const GATES: &[&str] = &[
    "fixture_text",
    "fixture_bytes",
    "fixture_present",
    "fixture_or_skip",
    "fixture_text_or_skip",
    "fixture_bytes_or_skip",
    "fixture_opt",
    "local_fixture_text",
];

/// `name` as a whole identifier (so `oracle_fixture_present` is not `fixture_present`).
fn mentions(src: &str, name: &str) -> bool {
    src.match_indices(name).any(|(i, _)| {
        let before = src[..i].chars().next_back();
        let after = src[i + name.len()..].chars().next();
        let ident = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
        !ident(before) && !ident(after)
    })
}

fn reads_ungated(src: &str) -> bool {
    let names_models = flattened_code(src).contains("tests/models");
    let reads = READS.iter().any(|r| src.contains(r));
    let gated = GATES.iter().any(|g| mentions(src, g));
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

#[test]
fn the_detector_sees_split_paths_and_non_read_probes() {
    // Each of these bypassed the original `tests/models` + `read_to_string(` pair.
    let join = "fn r(root: &Path) { let p = root.join(\"tests\").join(\"models\").join(\"a.ifc\"); let _ = std::fs::read_to_string(p); }";
    assert!(reads_ungated(join), "join chain");
    let multiline = "let p = root\n    .join(\"tests\")\n    .join(\"models\");\nlet _ = std::fs::read(p);";
    assert!(reads_ungated(multiline), "join chain across lines");
    let cc = "const P: &str = concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/../../tests/\", \"models/a.ifc\");\nfn r() { let _ = std::fs::read(P); }";
    assert!(reads_ungated(cc), "concat!");
    let open = "const P: &str = \"tests/models/a.ifc\";\nfn r() { let mut f = File::open(P).unwrap(); let mut v = vec![]; f.read_to_end(&mut v).unwrap(); }";
    assert!(reads_ungated(open), "File::open + read_to_end");
    let exists = "const P: &str = \"tests/models/a.ifc\";\n#[test] fn t() { if !Path::new(P).exists() { return; } }";
    assert!(reads_ungated(exists), ".exists() skip probe");
    let is_file = "fn t(root: &Path) { if !root.join(\"tests/models/a.ifc\").is_file() { return; } }";
    assert!(reads_ungated(is_file), ".is_file() skip probe");
    // Importing the crate for something else is not the gate.
    let other = format!("use ifc_lite_testkit::mesh;\n{open}");
    assert!(reads_ungated(&other), "bare crate import is not the gate");
    let gated = format!("{exists}\nlet _ = ifc_lite_testkit::fixture_present(\"a\");");
    assert!(!reads_ungated(&gated));
    // A hand-rolled `NotFound` + env-var match is a private copy of the policy.
    let own = "const P: &str = \"tests/models/a.ifc\";\nfn r() { match std::fs::read_to_string(P) { Err(e) if e.kind() == NotFound => { if std::env::var(\"IFC_LITE_REQUIRE_FIXTURES\").is_ok() { panic!() } } _ => {} } }";
    assert!(reads_ungated(own), "own missing-file match");
    // A look-alike helper name is not the gate.
    let lookalike = "const P: &str = \"tests/models/a.ifc\";\nfn oracle_fixture_present(p: &Path) -> bool { p.exists() }";
    assert!(reads_ungated(lookalike), "substring of a gate name");
}
