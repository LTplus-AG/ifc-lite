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

const LIMIT: usize = 400;
const ALLOWLIST: &str = include_str!("module_size_allowlist.txt");

/// Repo root = first ancestor holding both `rust/` and `apps/`. `None` in a
/// packaged/standalone context (the test then skips, like `styling_parity`).
fn repo_root() -> Option<std::path::PathBuf> {
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

fn collect_rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
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

/// Generated code and test/support files are not subject to the split rule.
fn is_exempt(rel: &str) -> bool {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    rel.contains("/generated/")
        || rel.contains("/tests/")
        || rel.contains("/examples/")
        || rel.contains("/benches/")
        || rel.contains("/fuzz/")
        // `#[cfg(test)]` module files embedded in src/ are test code, not
        // production modules subject to the split rule (e.g. src/tests.rs,
        // foo_tests.rs, foo_test.rs).
        || base == "tests.rs"
        || base.ends_with("_tests.rs")
        || base.ends_with("_test.rs")
}

/// Parse the committed allowlist into (relpath -> budget). Skips comment/blank
/// lines. A malformed data line is a hard error (the file is a contract).
fn parse_allowlist() -> std::collections::HashMap<String, usize> {
    let mut map = std::collections::HashMap::new();
    for line in ALLOWLIST.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (budget, path) = line
            .split_once(char::is_whitespace)
            .unwrap_or_else(|| panic!("module_size_allowlist.txt: malformed line: {line:?}"));
        let budget: usize = budget
            .trim()
            .parse()
            .unwrap_or_else(|_| panic!("module_size_allowlist.txt: bad budget in: {line:?}"));
        map.insert(path.trim().to_string(), budget);
    }
    map
}

fn line_count(path: &std::path::Path) -> usize {
    std::fs::read_to_string(path)
        .map(|s| s.lines().count())
        .unwrap_or(0)
}

/// Pure ratchet decision: given `(relpath, line_count)` for every non-exempt
/// file and the allowlist, return `(new_offenders, grew)`. Extracted from the
/// tree walk so the FIRING path (a new god file, or an allowlisted file over
/// budget) is unit-testable with synthetic inputs, not only the all-clean tree.
fn evaluate(
    files: &[(String, usize)],
    allowlist: &std::collections::HashMap<String, usize>,
) -> (Vec<String>, Vec<String>) {
    let mut new_offenders = Vec::new(); // over LIMIT, not allowlisted
    let mut grew = Vec::new(); // allowlisted, over budget
    for (rel, lines) in files {
        match allowlist.get(rel) {
            Some(&budget) if *lines > budget => {
                grew.push(format!("  {rel}: {lines} lines, budget {budget}"));
            }
            Some(_) => {}
            None if *lines > LIMIT => new_offenders.push(format!("  {rel}: {lines} lines")),
            None => {}
        }
    }
    new_offenders.sort();
    grew.sort();
    (new_offenders, grew)
}

#[test]
fn no_module_grows_past_its_ratchet_budget() {
    let Some(root) = repo_root() else {
        eprintln!("repo root not found (packaged context) - skipping module-size ratchet");
        return;
    };
    let allowlist = parse_allowlist();

    let mut paths = Vec::new();
    for top in ["rust", "apps"] {
        collect_rs_files(&root.join(top), &mut paths);
    }
    // (relpath, line_count) for every non-exempt file.
    let files: Vec<(String, usize)> = paths
        .iter()
        .map(|p| {
            (
                p.strip_prefix(&root).unwrap_or(p).to_string_lossy().replace('\\', "/"),
                line_count(p),
            )
        })
        .filter(|(rel, _)| !is_exempt(rel))
        .collect();

    // Advisory only (never fails the build, to avoid merge-order coupling): an
    // allowlisted file that dropped to <= LIMIT or vanished should have its row
    // removed so the list keeps trending down.
    let seen: std::collections::HashMap<&String, usize> =
        files.iter().map(|(r, n)| (r, *n)).collect();
    for rel in allowlist.keys() {
        match seen.get(rel) {
            None => eprintln!(
                "note: allowlist row {rel:?} no longer matches a tracked file (gone or now exempt); remove it"
            ),
            Some(&lines) if lines <= LIMIT => eprintln!(
                "note: {rel} is now {lines} <= {LIMIT} lines; remove its allowlist row (the total should trend down)"
            ),
            Some(_) => {}
        }
    }

    let (new_offenders, grew) = evaluate(&files, &allowlist);
    let mut msg = String::new();
    if !new_offenders.is_empty() {
        msg.push_str(&format!(
            "New non-generated .rs file(s) over {LIMIT} lines with no allowlist row.\n\
             Split them (AGENTS.md rule), or - only with a written justification - \
             add a row to rust/processing/tests/module_size_allowlist.txt:\n{}\n",
            new_offenders.join("\n")
        ));
    }
    if !grew.is_empty() {
        msg.push_str(&format!(
            "Allowlisted file(s) grew PAST their recorded budget. Shrink or split \
             instead of raising the budget:\n{}\n",
            grew.join("\n")
        ));
    }
    assert!(msg.is_empty(), "\n{msg}");
}

#[test]
fn evaluate_fires_on_new_god_file_and_over_budget() {
    let mut allowlist = std::collections::HashMap::new();
    allowlist.insert("rust/a/big.rs".to_string(), 500usize);
    allowlist.insert("rust/a/grown.rs".to_string(), 600usize);
    let files = vec![
        ("rust/a/small.rs".to_string(), 399),   // under the limit - clean
        ("rust/a/at_limit.rs".to_string(), 400), // exactly 400 is NOT > 400 - clean
        ("rust/a/new_god.rs".to_string(), 401), // new offender: >400, not allowlisted
        ("rust/a/big.rs".to_string(), 500),     // allowlisted, at budget - clean
        ("rust/a/grown.rs".to_string(), 601),   // allowlisted, over budget - FIRES
    ];
    let (new_offenders, grew) = evaluate(&files, &allowlist);
    assert_eq!(new_offenders, vec!["  rust/a/new_god.rs: 401 lines"]);
    assert_eq!(grew, vec!["  rust/a/grown.rs: 601 lines, budget 600"]);
}

#[test]
fn evaluate_is_clean_when_within_budget() {
    let mut allowlist = std::collections::HashMap::new();
    allowlist.insert("rust/a/big.rs".to_string(), 500usize);
    let files = vec![
        ("rust/a/small.rs".to_string(), 12),
        ("rust/a/big.rs".to_string(), 480), // shrank below budget - fine
    ];
    let (new_offenders, grew) = evaluate(&files, &allowlist);
    assert!(new_offenders.is_empty() && grew.is_empty());
}

#[test]
fn allowlist_is_well_formed_and_over_limit() {
    // The allowlist should only carry genuine debt: every budget must exceed
    // LIMIT (a <= LIMIT budget means the row is stale and should be deleted).
    let stale: Vec<_> = parse_allowlist()
        .into_iter()
        .filter(|(_, budget)| *budget <= LIMIT)
        .map(|(rel, budget)| format!("  {rel}: budget {budget} <= {LIMIT}"))
        .collect();
    assert!(
        stale.is_empty(),
        "allowlist rows at or under the {LIMIT}-line limit (delete them):\n{}",
        stale.join("\n")
    );
}
