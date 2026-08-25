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
const ALLOWLIST_DIGEST: u64 = 1345642162195250462;

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
    let actual = allowlist_digest();
    let total: usize = parse_allowlist().values().sum();
    assert_eq!(
        actual, ALLOWLIST_DIGEST,
        "module_size_allowlist.txt digest is {actual} (budgets total {total}), but \
         ALLOWLIST_DIGEST in module_size_ratchet.rs reads {ALLOWLIST_DIGEST}.\n\n\
         Raising a budget loosens the ratchet, so it must be visible: set \
         ALLOWLIST_DIGEST to {actual} in the SAME commit and say in the PR why \
         the module cannot be split. Lowering one, or deleting a row, is welcome \
         and must update the digest too so it keeps stating the real allowlist."
    );
}

/// FNV-1a over `path budget` rows, sorted by path so the digest is a function
/// of the allowlist's CONTENT and not of its line order.
fn allowlist_digest() -> u64 {
    let map = parse_allowlist();
    let mut rows: Vec<String> = map.iter().map(|(p, b)| format!("{p} {b}")).collect();
    rows.sort();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in rows.join("\n").bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}
