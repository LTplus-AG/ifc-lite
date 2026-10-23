// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Function-length ratchet (G4, charter #7670, #7697): the function-level
//! counterpart of `module_size_ratchet`. A function of `LIMIT` lines or more
//! (`fn` line through closing brace, inclusive) is a review burden no one
//! splits unprompted, so the tree accumulated 50+ of them, the worst
//! (`apply_void_context_inner`) 781 lines.
//!
//! Same two teeth as the module ratchet:
//!  1. A NEW function at or over `LIMIT` that has no row in
//!     `function_length_allowlist.txt` fails the build.
//!  2. An allowlisted function that GROWS past its recorded budget fails.
//!
//! Splitting a function below `LIMIT`, or shrinking it, calls for editing its
//! row (delete it, or lower the budget) so the debt only trends down. That is
//! advisory output rather than a failure, for the same reason as the module
//! ratchet: a hard failure would couple unrelated PRs by merge order.
//!
//! Scope and exemptions are shared with `module_size_ratchet`
//! (`common::source_walk`): production sources under `rust/` and `apps/`;
//! generated, `tests/`, `examples/`, `benches/`, `fuzz/` and `*_tests.rs` files
//! are exempt, and so is anything under `#[cfg(test)]` / `#[test]` inside a
//! production file. The scanner itself is `common::fn_scan`, unit-tested below.
//!
//! Row format: `<budget> <path> <key>`, where the key is `fn`, `Type::fn`,
//! `Type@Trait::fn` or `outer::inner` (a repeated key gets `#2`, `#3`). To
//! re-seed after a deliberate change, run
//! `cargo test -p ifc-lite-processing --test function_length_ratchet -- --ignored --nocapture print_current_offenders`.
//!
//! ANTI-VACUITY (#3200): the walk and the scan each have a floor, a missing or
//! unreadable root is a hard error, and the no-repo-root skip is refused under
//! CI, so an empty walk or a blind scanner cannot report a green test.

mod common;
use common::fn_scan::{scan, FnSpan};
use common::source_walk::{production_sources, repo_root};
use std::collections::BTreeMap;

/// A function this many lines long, or longer, needs an allowlist row.
const LIMIT: usize = 150;
const ALLOWLIST: &str = include_str!("function_length_allowlist.txt");
const GATE: &str = "function-length ratchet";

/// Walk floor, as in `module_size_ratchet`: roughly two thirds of the measured
/// production files (872 reached, the module ratchet keeps its own count).
const FILE_FLOOR: usize = 240;
/// Scan floor: the scanner must find at least this many production functions.
/// Measured 5423 (two thirds is the floor); a scanner that stops recognising `fn` finds a handful.
const FN_FLOOR: usize = 3600;

/// `(path, key) -> budget`.
type Allowlist = BTreeMap<(String, String), usize>;

fn parse_allowlist() -> Allowlist {
    parse_allowlist_text(ALLOWLIST)
}

/// Parse `<budget> <path> <key>` rows. Malformed rows and duplicate
/// `(path, key)` pairs are hard errors: the file is a contract, and a
/// duplicate is what a merge conflict resolved by keeping both sides leaves.
fn parse_allowlist_text(text: &str) -> Allowlist {
    let mut map = Allowlist::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        let [budget, path, key] = parts[..] else {
            panic!("function_length_allowlist.txt: malformed line (want '<budget> <path> <key>'): {line:?}");
        };
        let budget: usize = budget
            .parse()
            .unwrap_or_else(|_| panic!("function_length_allowlist.txt: bad budget in: {line:?}"));
        if let Some(previous) = map.insert((path.to_string(), key.to_string()), budget) {
            panic!(
                "function_length_allowlist.txt: duplicate row for {path} {key} (budgets \
                 {previous} and {budget}). Keep the one the function's measured length justifies."
            );
        }
    }
    map
}

/// Verdict over `(path, span)` pairs: `(new_offenders, grew, shrunk)`.
/// Pure, so the firing paths are unit-testable with synthetic input.
fn evaluate(
    fns: &[(String, FnSpan)],
    allowlist: &Allowlist,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut new_offenders = Vec::new();
    let mut grew = Vec::new();
    let mut shrunk = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (path, span) in fns {
        let lines = span.lines();
        let id = (path.clone(), span.key.clone());
        match allowlist.get(&id) {
            Some(&budget) if lines > budget => grew.push(format!(
                "  {path} {} (line {}): {lines} lines, budget {budget}",
                span.key, span.start
            )),
            Some(&budget) if lines < budget => shrunk.push(if lines < LIMIT {
                format!("  {path} {}: now {lines} lines (< {LIMIT}); delete its row", span.key)
            } else {
                format!("  {path} {}: now {lines} lines; lower its budget from {budget}", span.key)
            }),
            Some(_) => {}
            None if lines >= LIMIT => new_offenders.push(format!(
                "  {path} {} (line {}): {lines} lines",
                span.key, span.start
            )),
            None => {}
        }
        seen.insert(id);
    }
    for (path, key) in allowlist.keys() {
        if !seen.contains(&(path.clone(), key.clone())) {
            shrunk.push(format!(
                "  {path} {key}: no longer found (renamed, moved or deleted); delete or re-key its row"
            ));
        }
    }
    new_offenders.sort();
    grew.sort();
    shrunk.sort();
    (new_offenders, grew, shrunk)
}

/// Every production function with its repo-relative path. A file that cannot
/// be read is a hard error, not zero functions (#3200).
fn scan_tree() -> Option<(usize, Vec<(String, FnSpan)>)> {
    let Some(root) = repo_root() else {
        common::refuse_to_skip_in_ci(GATE);
        eprintln!("repo root not found (packaged context) - skipping {GATE}");
        return None;
    };
    let files = production_sources(GATE, &root);
    let mut fns = Vec::new();
    for (rel, path) in &files {
        let src = std::fs::read_to_string(path).unwrap_or_else(|err| {
            panic!(
                "{GATE}: {} could not be read ({err}). Refusing to count an \
                 unreadable file as holding no functions.",
                path.display()
            )
        });
        fns.extend(scan(&src).into_iter().map(|s| (rel.clone(), s)));
    }
    Some((files.len(), fns))
}

#[test]
fn no_function_grows_past_its_ratchet_budget() {
    let Some((file_count, fns)) = scan_tree() else { return };
    assert!(
        file_count >= FILE_FLOOR,
        "{GATE} walked rust/ and apps/ and reached only {file_count} non-exempt .rs \
         file(s); the floor is {FILE_FLOOR}. Refusing a vacuous pass: the walk \
         stopped working, the code did not go away."
    );
    assert!(
        fns.len() >= FN_FLOOR,
        "{GATE} scanned {file_count} files but found only {} function(s); the floor is \
         {FN_FLOOR}. Refusing a vacuous pass: the scanner has gone blind.",
        fns.len()
    );
    let (new_offenders, grew, shrunk) = evaluate(&fns, &parse_allowlist());
    for note in &shrunk {
        eprintln!("note (ratchet down): {}", note.trim());
    }
    let mut msg = String::new();
    if !new_offenders.is_empty() {
        msg.push_str(&format!(
            "New function(s) of {LIMIT}+ lines with no allowlist row.\n\
             Split them into named steps, or - only with a written justification - \
             add a row '<lines> <path> <key>' to \
             rust/processing/tests/function_length_allowlist.txt:\n{}\n",
            new_offenders.join("\n")
        ));
    }
    if !grew.is_empty() {
        msg.push_str(&format!(
            "Allowlisted function(s) grew PAST their recorded budget. Extract the \
             new logic into a helper instead of raising the budget:\n{}\n",
            grew.join("\n")
        ));
    }
    assert!(msg.is_empty(), "\n{msg}");
}

#[test]
fn allowlist_rows_are_over_the_limit_and_resolve() {
    let Some((_, fns)) = scan_tree() else { return };
    let allowlist = parse_allowlist();
    let stale: Vec<String> = allowlist
        .iter()
        .filter(|(_, &b)| b < LIMIT)
        .map(|((p, k), b)| format!("  {p} {k}: budget {b} < {LIMIT}"))
        .collect();
    assert!(
        stale.is_empty(),
        "allowlist rows under the {LIMIT}-line limit (delete them):\n{}",
        stale.join("\n")
    );
    // A row whose function is gone would otherwise sit there forever, and a
    // same-named newcomer would inherit its budget.
    let (_, _, shrunk) = evaluate(&fns, &allowlist);
    let orphans: Vec<&String> = shrunk.iter().filter(|m| m.contains("no longer found")).collect();
    assert!(
        orphans.is_empty(),
        "allowlist rows matching no function:\n{}",
        orphans.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n")
    );
}

/// Prints the current offenders as allowlist rows (re-seeding aid).
#[test]
#[ignore]
fn print_current_offenders() {
    let Some((_, fns)) = scan_tree() else { return };
    let mut rows: Vec<String> = fns
        .iter()
        .filter(|(_, s)| s.lines() >= LIMIT)
        .map(|(p, s)| format!("{:>7} {p} {}", s.lines(), s.key))
        .collect();
    rows.sort_by(|a, b| a.split_once(' ').map(|x| x.1.trim_start()).cmp(&b.split_once(' ').map(|x| x.1.trim_start())));
    println!("{}", rows.join("\n"));
}

fn fn_at(key: &str, start: usize, end: usize) -> (String, FnSpan) {
    ("rust/a/x.rs".to_string(), FnSpan { key: key.into(), start, end })
}

#[test]
fn evaluate_fires_on_new_offender_and_growth() {
    let mut allowlist = Allowlist::new();
    allowlist.insert(("rust/a/x.rs".into(), "big".into()), 200);
    allowlist.insert(("rust/a/x.rs".into(), "grown".into()), 300);
    let fns = vec![
        fn_at("small", 1, 149),      // 149 lines: clean
        fn_at("at_limit", 1, 150),   // 150 lines: FIRES (>= LIMIT)
        fn_at("big", 1, 200),        // at budget: clean
        fn_at("grown", 1, 301),      // 301 > 300: FIRES
    ];
    let (new_offenders, grew, shrunk) = evaluate(&fns, &allowlist);
    assert_eq!(new_offenders, vec!["  rust/a/x.rs at_limit (line 1): 150 lines"]);
    assert_eq!(grew, vec!["  rust/a/x.rs grown (line 1): 301 lines, budget 300"]);
    assert!(shrunk.is_empty());
}

#[test]
fn evaluate_asks_for_shrunk_and_vanished_rows_to_be_ratcheted_down() {
    let mut allowlist = Allowlist::new();
    allowlist.insert(("rust/a/x.rs".into(), "split".into()), 300);
    allowlist.insert(("rust/a/x.rs".into(), "trimmed".into()), 300);
    allowlist.insert(("rust/a/x.rs".into(), "gone".into()), 300);
    let fns = vec![fn_at("split", 1, 40), fn_at("trimmed", 1, 250)];
    let (new_offenders, grew, shrunk) = evaluate(&fns, &allowlist);
    assert!(new_offenders.is_empty() && grew.is_empty());
    assert_eq!(shrunk.len(), 3);
    assert!(shrunk.iter().any(|m| m.contains("gone") && m.contains("no longer found")));
    assert!(shrunk.iter().any(|m| m.contains("split") && m.contains("delete its row")));
    assert!(shrunk.iter().any(|m| m.contains("trimmed") && m.contains("lower its budget from 300")));
}

#[test]
#[should_panic(expected = "duplicate row for rust/a/x.rs big")]
fn parse_allowlist_refuses_a_duplicate_row() {
    parse_allowlist_text("200 rust/a/x.rs big\n210 rust/a/x.rs big\n");
}

#[test]
#[should_panic(expected = "malformed line")]
fn parse_allowlist_refuses_a_malformed_row() {
    parse_allowlist_text("200 rust/a/x.rs\n");
}

#[test]
fn parse_allowlist_text_reads_rows_past_comments_and_blanks() {
    let map = parse_allowlist_text("# h\n\n  200 rust/a/x.rs Foo::bar\n# why\n300 rust/b.rs baz#2\n");
    assert_eq!(map.len(), 2);
    assert_eq!(map[&("rust/a/x.rs".to_string(), "Foo::bar".to_string())], 200);
    assert_eq!(map[&("rust/b.rs".to_string(), "baz#2".to_string())], 300);
}

// ---- scanner unit tests: the tricky snippets ---------------------------------

/// `(key, lines)` for every function in `src`.
fn measured(src: &str) -> Vec<(String, usize)> {
    let mut v: Vec<_> = scan(src).iter().map(|s| (s.key.clone(), s.lines())).collect();
    v.sort();
    v
}

fn pair(k: &str, n: usize) -> (String, usize) {
    (k.to_string(), n)
}

#[test]
fn scanner_ignores_braces_in_strings_chars_comments_and_raw_strings() {
    let src = r####"fn a() {
    let s = "}} unbalanced \" } {";
    let c = '}';
    let q = '\'';
    let e = '\';
    // } line comment
    /* } block /* nested } */ still } comment */
    let r = r#"a "} quote"#;
    let r2 = r###"}"## }"###;
    let b = b"}";
    let rb = br#"}"#;
    let cs = c"}";
    let bc = b'}';
}
fn after() {}
"####;
    assert_eq!(measured(src), vec![pair("a", 14), pair("after", 1)]);
}

#[test]
fn scanner_tells_lifetimes_from_char_literals() {
    let src = "fn f<'a>(x: &'a str) -> &'a str {\n    'outer: loop { break 'outer; }\n    x\n}\nfn g() {}\n";
    assert_eq!(measured(src), vec![pair("f", 4), pair("g", 1)]);
}

#[test]
fn scanner_does_not_mistake_fn_inside_literals_or_comments_for_functions() {
    let src = "fn real() {\n    let s = \"fn fake() {\";\n    // fn fake2() {\n}\n";
    assert_eq!(measured(src), vec![pair("real", 4)]);
}

#[test]
fn scanner_skips_bodiless_declarations_and_fn_pointer_types() {
    let src = "trait T {\n    fn decl(&self);\n    fn with_default(&self) {\n    }\n}\n\
               type P = fn(u8) -> u8;\nstruct S { f: fn(u8), g: Box<dyn Fn(u8)> }\n\
               extern \"C\" { fn ffi(x: i32) -> i32; }\nfn real() {}\n";
    assert_eq!(
        measured(src),
        vec![pair("T::with_default", 2), pair("real", 1)]
    );
}

#[test]
fn scanner_counts_closures_in_their_function_and_measures_nested_fns_separately() {
    let src = "fn outer() {\n    let f = |x: u32| {\n        x + 1\n    };\n    fn inner() {\n        let g = || {\n        };\n    }\n    f(1);\n}\n";
    assert_eq!(measured(src), vec![pair("outer", 10), pair("outer::inner", 4)]);
}

#[test]
fn scanner_labels_impl_and_trait_methods() {
    let src = "impl<T: Clone> Foo<T> {\n    pub fn new() -> Self {\n        Foo {}\n    }\n}\n\
               impl<T> From<u8> for crate::a::Foo<T> where T: Copy {\n    fn from(x: u8) -> Self {\n    }\n}\n\
               impl Foo<u8> {\n    pub fn new() {\n    }\n}\n\
               mod inner {\n    pub fn m() {}\n}\n\
               impl<'a> Drop for &'a mut Bar {\n    fn drop(&mut self) {}\n}\n";
    assert_eq!(
        measured(src),
        vec![
            pair("Bar@Drop::drop", 1),
            pair("Foo::new", 3),
            pair("Foo::new#2", 2),
            pair("Foo@From::from", 2),
            pair("m", 1),
        ]
    );
}

#[test]
fn scanner_handles_multiline_and_generic_signatures() {
    let src = "pub(crate) async unsafe fn long<T, const N: usize>(\n    a: [u8; N],\n    f: impl Fn(u8) -> u8,\n) -> impl Iterator<Item = u8>\nwhere\n    T: Copy,\n{\n    a.into_iter()\n}\n";
    assert_eq!(measured(src), vec![pair("long", 9)]);
}

#[test]
fn scanner_skips_test_code_and_survives_struct_literals_and_macros() {
    let src = "fn prod() {\n    let s = S { a: 1 };\n}\n\
               #[cfg(test)]\nmod tests {\n    fn helper() {\n    }\n    #[test]\n    fn t() {}\n}\n\
               #[cfg(test)]\nfn only_in_tests() {\n}\n\
               #[test]\nfn plain_test() {\n}\n\
               mod test {\n    fn also_skipped() {}\n}\n\
               macro_rules! m {\n    ($n:ident) => {\n        fn $n() {\n        }\n    };\n}\n\
               #[cfg(test)]\nuse foo::bar;\nfn after_cfg_use() {}\n";
    assert_eq!(measured(src), vec![pair("after_cfg_use", 1), pair("prod", 3)]);
}

#[test]
fn scanner_reports_the_fn_line_through_the_closing_brace() {
    let spans = scan("\n\n// c\nfn f() {\n    x\n}\n");
    assert_eq!(spans.len(), 1);
    assert_eq!((spans[0].start, spans[0].end, spans[0].lines()), (4, 6, 3));
}

#[test]
fn mask_preserves_length_and_newlines() {
    let src = "a /* x\ny */ \"s\nt\" 'c' r#\"q\n\"# b";
    let masked: String = common::fn_scan::mask(src).into_iter().collect();
    assert_eq!(masked.chars().count(), src.chars().count());
    assert_eq!(masked.matches('\n').count(), src.matches('\n').count());
    assert!(!masked.contains(['x', 'y', 's', 't', 'c', 'q']));
}
