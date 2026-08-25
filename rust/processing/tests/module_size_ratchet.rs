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

mod scan_floor;

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
const ALLOWLIST_DIGEST: u64 = 4241476374134085635;



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
    // PANIC rather than `unwrap_or(0)` (#3200): 0 lines is under every budget,
    // so an unreadable file used to pass this gate silently.
    //
    // EXCEPT NotFound, which the walk itself can produce: `collect_rs_files`
    // pushes a dangling symlink ending in `.rs` (`is_dir()` is false, the
    // extension matches) and the read then fails with ENOENT. That is an
    // ordinary absence, and an earlier version of this comment asserted it
    // could not happen -- reproduced with `ln -s /nonexistent/nope.rs`. Every
    // other error (permissions, a filesystem fault) is still a real fault and
    // still loud.
    match std::fs::read_to_string(path) {
        Ok(s) => s.lines().count(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => panic!(
            "module-size ratchet could not read {} ({e}); refusing to count an unreadable \
             file as 0 lines, which is under every budget",
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
    let Some(root) = scan_floor::repo_root() else {
        eprintln!("repo root not found (packaged context) - skipping module-size ratchet");
        return;
    };
    let allowlist = parse_allowlist();

    // The walk and its floor live in `scan_floor` (#3200): `styling_parity`
    // greps the same two trees and needs the same refusal, and two copies of one
    // measurement drift.
    let paths = scan_floor::collect_with_floor(&root, "module-size ratchet");

    // (relpath, line_count) for every non-exempt file.
    //
    // EXEMPT FIRST, then read. The chain used to map-then-filter, which read all
    // 659 walked files to evaluate 362 of them. That was merely wasteful until
    // #3200 made `line_count` PANIC on an unreadable file: with the old order an
    // unreadable file under `tests/` or `generated/` would abort the whole
    // ratchet while naming a file the gate has no opinion about. The panic now
    // covers exactly the region the gate examines, and the read halves.
    let files: Vec<(String, usize)> = paths
        .iter()
        .map(|p| {
            (
                p.strip_prefix(&root).unwrap_or(p).to_string_lossy().replace('\\', "/"),
                p,
            )
        })
        .filter(|(rel, _)| !is_exempt(rel))
        .map(|(rel, p)| {
            let n = line_count(p);
            (rel, n)
        })
        .collect();

    // The floor in `collect_with_floor` is on files WALKED; this one is on files
    // actually EVALUATED, which is the region the verdict below speaks for.
    // Break `is_exempt` so it exempts everything and the walk floor still passes
    // over an empty evaluated set -- the same vacuity, one stage later.
    // Measured on a healthy tree: 362 non-exempt of 659 walked. Floor at 120.
    // If files were genuinely removed, lower EVALUATED_FLOOR in the same commit.
    const EVALUATED_FLOOR: usize = 120;
    assert!(
        files.len() >= EVALUATED_FLOOR,
        "module-size ratchet evaluated {} file(s) after exemptions, expected at least \
         {EVALUATED_FLOOR}. Refusing to report a clean ratchet over an empty set -- the walk \
         found files but the EXEMPTIONS swallowed them.",
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
