// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Positional-read ratchet (G-F3e, charter #7670, #7780): the guard behind the
//! typed slots of `ifc_lite_core::slot`.
//!
//! An attribute read by a bare integer (`entity.get_ref(5)`) names nothing and
//! cannot say which schema it assumes. The tree held 1,300+ of them, 7 copies
//! of `IfcProject.UnitsInContext` among them, and three that were wrong on
//! IFC4X1/4X2 files (`IfcLinearPlacement`, `IfcAlignment.Axis`). New reads go
//! through `slot::<Entity>::<ATTR>` (a moving one through `decoder.slot(..)`),
//! and this test holds the old ones to an exact per-file count.
//!
//! The same two teeth as G2, in both directions:
//!  1. A file with MORE literal reads than its row (or any read and no row)
//!     fails: "use `slot::<Entity>::<ATTR>`".
//!  2. A file with FEWER fails as stale until its row is lowered or deleted, so
//!     the debt only shrinks, and a converted site cannot be re-added by a
//!     later merge unnoticed.
//!
//! What counts, and what does not, is `common::read_scan`: literal integer
//! arguments of `get`, `get_ref`, `get_refs`, `get_float`, `get_string`,
//! `get_list`, `is_present` and the F3e `*_at`/`attr` accessors, the last
//! argument of `nth_attr*`, and `attributes[N]`. A named constant or a
//! computed index is not counted. A line that is genuinely not an attribute
//! read carries `// not-an-attribute`; the markers are counted separately and
//! printed, so review sees every one.
//!
//! Scope is `common::source_walk::production_sources` (so `generated/`,
//! `tests/`, `examples/`, `benches/`, `fuzz/`, `*_tests.rs` and `#[cfg(test)]`
//! items are exempt), minus `rust/landxml` (XML, no STEP records).
//!
//! Row format: `<count> <path>`. To re-seed after a deliberate change, run
//! `cargo test -p ifc-lite-processing --test positional_read_ratchet -- --ignored --nocapture print_current_counts`.
//!
//! ANTI-VACUITY (#3200): the walk and the scan each have a floor, a missing
//! or unreadable root is a hard error, and the no-repo-root skip is refused
//! under CI.

mod common;
use common::read_scan::{scan, Reads};
use common::source_walk::{production_sources, repo_root};
use std::collections::BTreeMap;

const ALLOWLIST: &str = include_str!("positional_read_allowlist.txt");
const GATE: &str = "positional-read ratchet";
/// The crate that reads XML, not STEP records.
const EXEMPT_PREFIX: &str = "rust/landxml/";

/// Walk floor: production files seen (roughly two thirds of the measured
/// count, as in the other source-walking gates).
const FILE_FLOOR: usize = 240;
type Allowlist = BTreeMap<String, usize>;

fn parse_allowlist() -> Allowlist {
    parse_allowlist_text(ALLOWLIST)
}

/// Parse `<count> <path>` rows. A malformed row, a zero count and a duplicate
/// path are hard errors: the file is a contract, and a duplicate is what a
/// merge conflict resolved by keeping both sides leaves.
fn parse_allowlist_text(text: &str) -> Allowlist {
    let mut map = Allowlist::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        let [count, path] = parts[..] else {
            panic!("positional_read_allowlist.txt: malformed line (want '<count> <path>'): {line:?}");
        };
        let count: usize = count
            .parse()
            .unwrap_or_else(|_| panic!("positional_read_allowlist.txt: bad count in: {line:?}"));
        assert!(count > 0, "positional_read_allowlist.txt: delete the row instead of keeping count 0: {line:?}");
        if let Some(previous) = map.insert(path.to_string(), count) {
            panic!(
                "positional_read_allowlist.txt: duplicate row for {path} (counts {previous} and \
                 {count}). Keep the one the file's measured reads justify."
            );
        }
    }
    map
}

/// `(path, reads)` of every in-scope file. A file that cannot be read is a
/// hard error, not zero reads (#3200).
fn scan_tree() -> Option<Vec<(String, Reads)>> {
    let Some(root) = repo_root() else {
        common::refuse_to_skip_in_ci(GATE);
        eprintln!("repo root not found (packaged context) - skipping {GATE}");
        return None;
    };
    let files = production_sources(GATE, &root);
    assert!(
        files.len() >= FILE_FLOOR,
        "{GATE}: the walk found {} production files, below the floor of {FILE_FLOOR}. The walk \
         roots are wrong; this gate is not looking at the tree.",
        files.len()
    );
    let mut out = Vec::new();
    for (rel, path) in files {
        if rel.starts_with(EXEMPT_PREFIX) {
            continue;
        }
        let src = std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("{GATE}: {rel} could not be read ({err})"));
        out.push((rel, scan(&src)));
    }
    Some(out)
}

/// Verdict over per-file reads: `(grew, shrank, stale_rows)`. Pure, so the
/// firing paths are unit-testable with synthetic input.
fn evaluate(files: &[(String, Reads)], allowlist: &Allowlist) -> (Vec<String>, Vec<String>, Vec<String>) {
    let (mut grew, mut shrank, mut stale) = (Vec::new(), Vec::new(), Vec::new());
    let mut seen = std::collections::HashSet::new();
    for (path, reads) in files {
        let found = reads.counted.len();
        let allowed = allowlist.get(path).copied().unwrap_or(0);
        seen.insert(path.as_str());
        if found > allowed {
            let sites: Vec<String> =
                reads.counted.iter().map(|r| format!("      {path}:{} {}", r.line, r.text)).collect();
            grew.push(format!(
                "  {path}: {found} literal attribute reads, allowed {allowed}. Read it through \
                 `slot::<Entity>::<ATTR>` (a moving slot through `decoder.slot(..)`), or mark a \
                 non-attribute line `// not-an-attribute`.\n{}",
                sites.join("\n")
            ));
        } else if found < allowed {
            shrank.push(if found == 0 {
                format!("  {path}: now {found} (was {allowed}); delete its row")
            } else {
                format!("  {path}: now {found} (was {allowed}); lower its row to {found}")
            });
        }
    }
    for path in allowlist.keys() {
        if !seen.contains(path.as_str()) {
            stale.push(format!(
                "  {path}: no such production file (renamed, moved, deleted or exempt); delete or re-key its row"
            ));
        }
    }
    grew.sort();
    shrank.sort();
    stale.sort();
    (grew, shrank, stale)
}

#[test]
fn no_new_literal_attribute_reads_and_no_stale_rows() {
    common::positional_canary::assert_scanner_canary(scan);
    let Some(files) = scan_tree() else { return };
    let marked: Vec<String> = files
        .iter()
        .flat_map(|(path, r)| r.marked.iter().map(move |m| format!("  {path}:{} {}", m.line, m.text)))
        .collect();
    if !marked.is_empty() {
        eprintln!("{GATE}: {} `// not-an-attribute` markers:\n{}", marked.len(), marked.join("\n"));
    }
    let (grew, shrank, stale) = evaluate(&files, &parse_allowlist());
    let mut problems = Vec::new();
    if !grew.is_empty() {
        problems.push(format!("New literal attribute reads (the debt may only shrink):\n{}", grew.join("\n")));
    }
    if !shrank.is_empty() {
        problems.push(format!(
            "Reads were converted; lower the row so they cannot come back unnoticed:\n{}",
            shrank.join("\n")
        ));
    }
    if !stale.is_empty() {
        problems.push(format!("Rows for files that are gone:\n{}", stale.join("\n")));
    }
    assert!(problems.is_empty(), "{GATE}:\n{}", problems.join("\n"));
}

/// Print the current counts in allowlist format (re-seed helper).
#[test]
#[ignore = "re-seed helper: run with --ignored --nocapture"]
fn print_current_counts() {
    let Some(files) = scan_tree() else { return };
    let mut total = 0;
    for (path, reads) in &files {
        if !reads.counted.is_empty() {
            total += reads.counted.len();
            println!("{} {path}", reads.counted.len());
        }
    }
    eprintln!("total {total} in {} files", files.iter().filter(|(_, r)| !r.counted.is_empty()).count());
}

fn reads(lines: &[(usize, &str)]) -> Reads {
    Reads {
        counted: lines
            .iter()
            .map(|&(line, text)| common::read_scan::Read { line, text: text.to_string() })
            .collect(),
        marked: Vec::new(),
    }
}

#[test]
fn a_new_read_fails_and_names_the_site() {
    let files = [("rust/geometry/src/profiles/shapes.rs".to_string(), reads(&[(10, "get_ref(3)"), (20, "get(1)")]))];
    let allow = Allowlist::from([("rust/geometry/src/profiles/shapes.rs".to_string(), 1)]);
    let (grew, shrank, stale) = evaluate(&files, &allow);
    assert_eq!(grew.len(), 1);
    assert!(grew[0].contains("shapes.rs:10 get_ref(3)") && grew[0].contains("slot::<Entity>::<ATTR>"), "{grew:?}");
    assert!(shrank.is_empty() && stale.is_empty());
}

#[test]
fn a_file_with_reads_and_no_row_fails() {
    let files = [("rust/core/src/new.rs".to_string(), reads(&[(1, "get(0)")]))];
    let (grew, _, _) = evaluate(&files, &Allowlist::new());
    assert_eq!(grew.len(), 1);
}

#[test]
fn a_converted_read_fails_as_stale_until_the_row_is_lowered() {
    let files = [("rust/core/src/a.rs".to_string(), reads(&[(1, "get(0)")]))];
    let allow = Allowlist::from([("rust/core/src/a.rs".to_string(), 2)]);
    let (grew, shrank, _) = evaluate(&files, &allow);
    assert!(grew.is_empty());
    assert_eq!(shrank, ["  rust/core/src/a.rs: now 1 (was 2); lower its row to 1"]);
    let cleared = [("rust/core/src/a.rs".to_string(), reads(&[]))];
    assert!(evaluate(&cleared, &allow).1[0].contains("delete its row"));
}

#[test]
fn a_row_for_a_missing_file_fails() {
    let allow = Allowlist::from([("rust/core/src/gone.rs".to_string(), 1)]);
    let (_, _, stale) = evaluate(&[], &allow);
    assert_eq!(stale.len(), 1);
}

#[test]
fn an_exact_match_passes() {
    let files = [("rust/core/src/a.rs".to_string(), reads(&[(1, "get(0)"), (2, "get(1)")]))];
    let allow = Allowlist::from([("rust/core/src/a.rs".to_string(), 2)]);
    assert_eq!(evaluate(&files, &allow), (vec![], vec![], vec![]));
}

#[test]
#[should_panic(expected = "duplicate row")]
fn a_duplicate_row_is_a_hard_error() {
    parse_allowlist_text("1 a.rs\n2 a.rs\n");
}

#[test]
#[should_panic(expected = "delete the row")]
fn a_zero_row_is_a_hard_error() {
    parse_allowlist_text("0 a.rs\n");
}

#[test]
#[should_panic(expected = "malformed")]
fn a_malformed_row_is_a_hard_error() {
    parse_allowlist_text("12\n");
}

#[test]
fn fixed_scanner_corpus_matches_all_expected_sites() {
    common::positional_canary::assert_scanner_canary(scan);
}

#[test]
fn empty_reads_fail_the_scanner_canary() {
    let error = common::positional_canary::validate(&Reads::default()).expect_err("an empty scan must fail");
    assert!(error.contains("scanner canary"), "{error}");
}

#[test]
fn partial_binary_accessor_blindness_fails_the_scanner_canary() {
    let changed = common::positional_canary::CORPUS
        .replace("binary_at(16)", "binary_at(slot::IfcWall::NAME.index())");
    assert_ne!(changed, common::positional_canary::CORPUS, "the mutation must target the fixed binary site");
    let error = common::positional_canary::validate(&scan(&changed)).expect_err("losing one site must fail");
    assert!(error.contains("scanner canary"), "{error}");
}

#[test]
fn typed_named_and_computed_reads_allow_zero_debt() {
    let source = "fn only_slots(entity: &Entity, i: usize) {\n\
        entity.get(slot::IfcWall::NAME.index());\n\
        entity.attr(SLOT);\n\
        entity.get(i + 1);\n\
    }\n";
    let files = [("synthetic.rs".to_string(), scan(source))];
    assert_eq!(files[0].1.counted.len(), 0);
    assert_eq!(evaluate(&files, &Allowlist::new()), (vec![], vec![], vec![]));
}

/// The scanner on synthetic source: what counts, what does not.
mod scanner {
    use crate::common::read_scan::{is_int_literal, scan};

    fn counted(src: &str) -> Vec<String> {
        scan(src).counted.into_iter().map(|r| r.text).collect()
    }

    #[test]
    fn counts_the_untyped_and_typed_accessors() {
        let src = "fn f(e: &E) { e.get(3); e.get_ref(5); x.get_refs(0usize); e.get_float(1_0);\
            e.get_string(2); e.get_list(4); e.attr(6); e.ref_at(7); e.logical_at(0x2); }";
        assert_eq!(
            counted(src),
            [
                "get(3)", "get_ref(5)", "get_refs(0usize)", "get_float(1_0)", "get_string(2)",
                "get_list(4)", "attr(6)", "ref_at(7)", "logical_at(0x2)"
            ]
        );
    }

    #[test]
    fn counts_attributes_index_and_nth_attr_last_argument() {
        let src = "fn f() { let a = e.attributes[3]; nth_attr(bytes, 9); nth_attr_int(b, 0, 4); \
            nth_attribute_is_present(b, 2); let b = v.attributes[i]; }";
        assert_eq!(
            counted(src),
            ["attributes[3]", "nth_attr(9)", "nth_attr_int(4)", "nth_attribute_is_present(2)"]
        );
    }

    #[test]
    fn names_computed_positions_and_other_shapes_are_not_counted() {
        let src = "fn f(i: usize) { e.get(i); e.get(IDX); e.get(i + 1); e.get(3, 4); get(3); \
            e.get_ref(slot::IfcWall::OBJECT_PLACEMENT.index()); e.get(); e.map.get(\"k\"); \
            e.get(-1); e.get(1.5); }";
        assert_eq!(counted(src), Vec::<String>::new());
    }

    #[test]
    fn comments_strings_and_test_items_are_invisible() {
        let src = "fn f() {\n // e.get(1)\n let s = \"e.get(2)\"; /* e.get(3) */\n}\n\
            #[cfg(test)]\nmod tests { fn t() { e.get(4); } }\n\
            #[test]\nfn one() { e.get(5); }\n\
            #[cfg(test)]\nfn helper() -> u32 { e.get(6) }\n\
            fn after() { e.get(7); }\n";
        assert_eq!(counted(src), ["get(7)"], "only the production read after the test items counts");
    }

    #[test]
    fn marker_lines_are_counted_separately() {
        let src = "fn f() {\n let a = parts.get(0); // not-an-attribute: split result\n let b = e.get(1);\n}\n";
        let reads = scan(src);
        assert_eq!(reads.marked.iter().map(|r| r.line).collect::<Vec<_>>(), [2]);
        assert_eq!(reads.counted.iter().map(|r| (r.line, r.text.as_str())).collect::<Vec<_>>(), [(3, "get(1)")]);
    }

    #[test]
    fn reports_lines_and_nested_reads() {
        let src = "fn f() {\n let x = e.get_ref(0).and_then(|r| d.decode(r).get_ref(3));\n}\n";
        let reads = scan(src);
        assert_eq!(reads.counted.len(), 2, "{reads:?}");
        assert!(reads.counted.iter().all(|r| r.line == 2));
    }

    #[test]
    fn int_literal_grammar() {
        for yes in ["0", "7", "1_000", "3usize", "0x1f", "0b101", "2u8", "10i32"] {
            assert!(is_int_literal(yes), "{yes}");
        }
        for no in ["", "i", "IDX", "-1", "1.5", "1e3", "0x", "_1", "3 + 1", "3foo"] {
            assert!(!is_int_literal(no), "{no}");
        }
    }
}
