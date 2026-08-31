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
    ("apps/server", 12409080334009393247),
    ("rust/core", 13402756985857706732),
    ("rust/export", 15791359419451037914),
    ("rust/geometry", 5850574697340138616),
    ("rust/processing", 7633784028779437211),
    ("rust/wasm-bindings", 11372642225568989008),
];

/// Lower bound on how many non-exempt `.rs` files the walk must reach before
/// its verdict means anything. Every offender this gate can report is pushed
/// inside `for (rel, lines) in files`, so an empty `files` produces an empty
/// message and a green test - a pass over a region the gate never examined
/// (#3200).
///
/// MEASURED, not guessed: the walk over `rust/` + `apps/` reaches 362
/// non-exempt files on a healthy tree (raise the floor and run the test to see
/// the real figure in the failure message). The floor below sits at roughly two
/// thirds of that, which is the right shape of
/// headroom here: this number only has to separate "the walk works" from "the
/// walk went blind", and every way it can go blind - a wrong scan root, a
/// `read_dir` that fails, a crate tree that moved - takes the count to zero or
/// to a handful, never to a plausible-looking fraction. Deleting a whole crate
/// is the only ordinary event that would approach it, and that is a change
/// worth editing this line for.
const FILE_FLOOR: usize = 240;

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

/// Walk `dir`, collecting every `.rs` file underneath it.
///
/// A directory this cannot list is a hard error, and the two reasons are told
/// apart. The previous `let Ok(entries) = read_dir(dir) else { return; };`
/// collapsed "the scan root is not there" and "the scan root cannot be opened"
/// into the same result as "this directory holds no Rust files" - which is how
/// this ratchet could report success over a tree it never opened (#3200). A
/// missing directory means the walk roots are wrong; an unreadable one means
/// the environment is. Neither means there are no offenders.
fn collect_rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => panic!(
            "module-size ratchet: {} does not exist. Refusing to treat a missing \
             directory as one holding no .rs files - a walk root that is not \
             there means this gate is looking in the wrong place, not that the \
             tree is clean.",
            dir.display()
        ),
        Err(err) => panic!(
            "module-size ratchet: {} could not be read ({err}). Refusing to treat \
             an unreadable directory as one holding no .rs files.",
            dir.display()
        ),
    };
    for entry in entries {
        let entry = entry.unwrap_or_else(|err| {
            panic!(
                "module-size ratchet: an entry of {} could not be read ({err}). \
                 Refusing to walk past a file this gate could not classify.",
                dir.display()
            )
        });
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

/// Line count for one file. An unreadable file is a hard error, not zero: 0 is
/// under LIMIT and under every allowlist budget, so `unwrap_or(0)` made a file
/// this gate could not open indistinguishable from a file that passes it.
fn line_count(path: &std::path::Path) -> usize {
    match std::fs::read_to_string(path) {
        Ok(s) => s.lines().count(),
        Err(err) => panic!(
            "module-size ratchet: {} could not be read ({err}). Refusing to count \
             an unreadable file as 0 lines - 0 is under every budget, so the file \
             would pass the ratchet without ever being measured.",
            path.display()
        ),
    }
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
        common::refuse_to_skip_in_ci("module-size ratchet");
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

    // Anti-vacuity (#3200). Placed above every verdict below, because all of
    // them are computed by iterating `files`: zero files gives zero offenders
    // gives a green test, which is this gate reporting success over a tree it
    // never looked at.
    assert!(
        files.len() >= FILE_FLOOR,
        "module-size ratchet walked rust/ and apps/ and reached only {} non-exempt \
         .rs file(s); the floor is {FILE_FLOOR}. Refusing a vacuous pass: every \
         check below iterates this list, so a count this low means the walk \
         stopped working, not that the modules went away. If crates were \
         genuinely removed, lower FILE_FLOOR in the same commit.",
        files.len()
    );

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

/// The allowlist's content digest must equal the pinned figure. Any raise, any
/// lowering, any added or removed row moves it, including a compensating pair
/// that leaves the total untouched. Growth and shrinkage both fail, so the
/// pinned value keeps stating the real allowlist in the same commit that
/// changes it, where a reviewer sees it.
#[test]
fn allowlist_digest_is_pinned() {
    let rows = parse_allowlist();
    let actual = allowlist_digests();
    let pinned: BTreeMap<String, u64> = ALLOWLIST_DIGESTS
        .iter()
        .map(|(s, d)| ((*s).to_string(), *d))
        .collect();
    let total: usize = rows.values().sum();

    let drifted: Vec<String> = actual
        .iter()
        .filter(|(scope, d)| pinned.get(*scope) != Some(*d))
        .map(|(scope, d)| format!("    (\"{scope}\", {d}),"))
        .collect();
    // A pinned scope with no rows left is drift too: without this, deleting
    // every row of a scope leaves a pin describing nothing and the gate stays
    // silent -- the vacuity shape this repo keeps rediscovering (#3200).
    let orphaned: Vec<&str> = pinned
        .keys()
        .filter(|s| !actual.contains_key(*s))
        .map(String::as_str)
        .collect();

    assert!(
        drifted.is_empty() && orphaned.is_empty(),
        "module_size_allowlist.txt has {} rows, budgets total {total}, and {} scope(s) \
         disagree with ALLOWLIST_DIGESTS in module_size_ratchet.rs.\n\n\
         Raising a budget loosens the ratchet, so it must be visible. Set these entries \
         in the SAME commit and say in the PR why the module cannot be split:\n\n{}\n\n\
         Orphaned pins (no rows left, delete them): {:?}\n\n\
         Only the scopes listed moved; every other entry stays as it is.",
        rows.len(),
        drifted.len() + orphaned.len(),
        drifted.join("\n"),
        orphaned
    );
}

#[test]
fn allowlist_scope_matches_the_shared_vectors() {
    // The digest-table parity test in scripts/lib/module-size-ratchet.test.mjs
    // CANNOT see a scope-rule divergence on its own. It runs the shared rule
    // only over THIS allowlist, which holds zero `packages/` rows, so the
    // `packages` branch is dead on that input: deleting it leaves every digest
    // byte-identical and every gate green. Measured, not assumed -- that
    // mutation passed everything before this test existed.
    //
    // So both halves are held to the same vectors instead, the pattern this
    // repo already uses for csv_cell_vectors.json and unit_scale_vectors.json.
    let raw = include_str!("fixtures/module_size_scope_vectors.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    let cases = doc["cases"].as_array().expect("fixture has a cases array");
    // Anti-vacuity: a fixture that parsed to nothing would pass this test
    // silently, which is the shape the vectors exist to stop.
    assert!(
        cases.len() >= 10,
        "expected the full vector set, got {}",
        cases.len()
    );
    for case in cases {
        let path = case["path"].as_str().expect("case.path is a string");
        let want = case["scope"].as_str().expect("case.scope is a string");
        assert_eq!(
            allowlist_scope(path),
            want,
            "scope rule disagrees with the shared vectors for {path:?}; the JS twin \
             (allowlistScope in scripts/lib/module-size-ratchet.mjs) is held to the same file"
        );
    }
}

/// The SCOPE a row's digest belongs to: `packages/<name>`, `apps/<name>`,
/// `rust/<crate>`, or the first path segment for anything else ("other" when
/// that segment is empty). Mirrors `allowlistScope` in
/// `scripts/lib/module-size-ratchet.mjs` (#3291).
///
/// `packages/` IS listed here on purpose even though this allowlist holds no
/// `packages/` row: an earlier version of this doc omitted it, which is exactly
/// the edit that silently desyncs the two halves, because the digest comparison
/// cannot reach a branch its input never exercises. The shared vectors in
/// `fixtures/module_size_scope_vectors.json` are what catch it.
fn allowlist_scope(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() >= 2 && matches!(parts[0], "packages" | "apps" | "rust") {
        return format!("{}/{}", parts[0], parts[1]);
    }
    // `.filter(|p| !p.is_empty())`, not just `.first()`: `str::split` never
    // yields an empty iterator, so the fallback was unreachable and an empty or
    // leading-slash path returned "" here while the JS twin returned "other".
    // Two mirror functions that already were not mirrors -- caught by the
    // shared vectors in fixtures/module_size_scope_vectors.json, which is why
    // they exist rather than being tested against production data alone.
    parts
        .first()
        .filter(|p| !p.is_empty())
        .map_or_else(|| "other".to_string(), |p| (*p).to_string())
}

/// FNV-1a over `path budget` rows, sorted by path so the digest is a function
/// of the allowlist's CONTENT and not of its line order.
fn digest_rows(rows: &BTreeMap<String, usize>) -> u64 {
    let mut lines: Vec<String> = rows.iter().map(|(p, b)| format!("{p} {b}")).collect();
    lines.sort();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in lines.join("\n").bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Per-scope digests. Sharded for the same reason the TypeScript twin is: one
/// repo-wide pin made every PR touching ANY budget conflict with every other,
/// because they all rewrote the same line.
///
/// This half is sharded because the two gates are twins and a twin that drifts
/// is worse than either shape -- NOT because this file is the busier one.
///
/// Note the residual is WORSE here than on the TS side, for a reason that has
/// nothing to do with how often the file changes: git cannot auto-merge two
/// edits on adjacent lines, and this table has 6 entries against the TS table's
/// 37, so 5 of its 15 cross-scope pairs (33%) are adjacent versus 36 of 666
/// (5.4%) there. Sharding takes both from 100%; it does not take either to 0. An
/// earlier draft of this comment claimed it was, on a miscount: `git log -200
/// -- <path>` limits to 200 commits TOUCHING that path, so it returned each
/// file's whole history and compared seven weeks of this file against three
/// days of the TS one. Counting properly, of the last 200 commits on main, 6
/// touch this allowlist and 18 touch the TS one.
fn allowlist_digests() -> BTreeMap<String, u64> {
    let mut by_scope: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    for (path, budget) in parse_allowlist() {
        by_scope
            .entry(allowlist_scope(&path))
            .or_default()
            .insert(path, budget);
    }
    by_scope
        .into_iter()
        .map(|(scope, rows)| (scope, digest_rows(&rows)))
        .collect()
}
