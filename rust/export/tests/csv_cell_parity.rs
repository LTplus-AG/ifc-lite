// SPDX-License-Identifier: MPL-2.0

//! Rust half of the CSV-cell cross-language parity pin.
//!
//! Pins `ifc_lite_export::csv_cell::escape_csv_cell` to the shared vectors in
//! `tests/fixtures/csv_cell_vectors.json`. The TypeScript escaper
//! (`packages/export/src/csv-cell.ts`, via `csv-cell.parity.test.ts`) is held
//! to the SAME file, so the two cannot drift apart silently. Follows the
//! precedent set by `rust/core/tests/unit_scale_parity.rs` for the length-unit
//! extractors.

use ifc_lite_export::csv_cell::{escape_csv_cell, is_invisible_prefix, is_padding, CsvCellOptions};

/// Read one `[[lo, hi], ...]` block out of the fixture, checking it is sorted,
/// non-overlapping and non-adjacent — an adjacent pair would make a hand-edit
/// of either language's table silently ambiguous.
fn ranges(doc: &serde_json::Value, key: &str) -> Vec<(u32, u32)> {
    let out: Vec<(u32, u32)> = doc[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} is an array"))
        .iter()
        .map(|r| {
            let a = r[0].as_u64().expect("range start is a number") as u32;
            let b = r[1].as_u64().expect("range end is a number") as u32;
            (a, b)
        })
        .collect();
    assert!(!out.is_empty(), "{key} carries at least one range");
    for i in 0..out.len() {
        assert!(out[i].0 <= out[i].1, "{key} range {i} is inverted");
        if i > 0 {
            assert!(out[i].0 > out[i - 1].1 + 1, "{key} ranges {} and {i} overlap or abut", i - 1);
        }
    }
    out
}

/// Sweep every code point against a fixture table. Sweeps rather than samples:
/// the whole failure mode of these classes is ONE unlisted code point, so a
/// sample is exactly the wrong shape of test.
fn sweep(name: &str, table: &[(u32, u32)], classify: impl Fn(char) -> bool) {
    let mut mismatches: Vec<String> = Vec::new();
    for cp in 0u32..=0x10FFFF {
        // `from_u32` rejects lone surrogates (category Cs, in none of the classes).
        let Some(ch) = char::from_u32(cp) else { continue };
        let in_table = table.iter().any(|&(a, b)| cp >= a && cp <= b);
        let in_fn = classify(ch);
        if in_table != in_fn && mismatches.len() < 10 {
            mismatches.push(format!("U+{cp:04X}: fn={in_fn} table={in_table}"));
        }
    }
    assert!(mismatches.is_empty(), "{name} diverges from the shared table: {mismatches:?}");
}

fn fixture() -> serde_json::Value {
    let raw = include_str!("fixtures/csv_cell_vectors.json");
    serde_json::from_str(raw).expect("fixture is valid JSON")
}

#[test]
fn rust_csv_cell_matches_shared_vectors() {
    let doc = fixture();
    let cases = doc["cases"].as_array().expect("cases is an array");
    assert!(
        cases.len() > 20,
        "an empty or near-empty vector list proves nothing; got {}",
        cases.len()
    );

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let input = case["input"].as_str().expect("input is a string");
        let expected = case["expected"].as_str().expect("expected is a string");
        // An ABSENT field means "whatever the library defaults to", not a
        // hard-coded value. Restating the defaults here made the harness blind
        // to the one thing it exists to catch: the two languages' defaults
        // drifting apart. Vectors that name no options pin both defaults.
        let defaults = CsvCellOptions::default();
        let opts = CsvCellOptions {
            delimiter: case["delimiter"].as_str().unwrap_or(defaults.delimiter),
            exempt_numbers: case["exemptNumbers"]
                .as_bool()
                .unwrap_or(defaults.exempt_numbers),
            quote_whitespace_padded: case["quoteWhitespacePadded"]
                .as_bool()
                .unwrap_or(defaults.quote_whitespace_padded),
        };

        let got = escape_csv_cell(input, &opts);
        assert_eq!(
            got, expected,
            "vector `{name}`: input {input:?} gave {got:?}, want {expected:?}"
        );
    }
}

/// A failure here is real drift between this crate's const table and the
/// Unicode `Cf`+`Z` classes the TypeScript side matches — fix the table, never
/// the assertion.
#[test]
fn invisible_prefix_table_matches_the_shared_ranges() {
    let doc = fixture();
    sweep(
        "invisible-prefix classification",
        &ranges(&doc, "invisiblePrefixRanges"),
        is_invisible_prefix,
    );
}

/// The padding class the TypeScript side spells as JavaScript `\s`, which is
/// NOT Rust's `char::is_whitespace`. Two code points differ (U+0085, U+FEFF),
/// and this sweep is the only thing that would catch someone "simplifying"
/// `is_padding` back to `char::is_whitespace`.
#[test]
fn padding_table_matches_the_shared_ranges() {
    let doc = fixture();
    sweep("padding classification", &ranges(&doc, "paddingRanges"), is_padding);
}

/// The two code points where JS `\s` and Unicode `White_Space` disagree, named
/// rather than left to the sweep, so a regression says *what* broke.
#[test]
fn padding_class_resolves_the_js_vs_white_space_asymmetry() {
    assert!(is_padding('\u{FEFF}'), "JS \\s includes the BOM; White_Space does not");
    assert!(!is_padding('\u{0085}'), "JS \\s excludes NEL; White_Space includes it");
    assert!('\u{0085}'.is_whitespace(), "premise: NEL IS White_Space, hence the carve-out");
    assert!(!'\u{FEFF}'.is_whitespace(), "premise: the BOM is NOT White_Space, hence the add-back");
}

/// The named bypasses that motivated the class, spelled out so a table
/// regeneration that dropped one is caught by name and not by a code point in a
/// diff.
#[test]
fn named_bypasses_are_all_covered() {
    for (label, ch) in [
        ("BOM U+FEFF", '\u{FEFF}'),
        ("ZWSP U+200B", '\u{200B}'),
        ("LRM U+200E", '\u{200E}'),
        ("NBSP U+00A0", '\u{00A0}'),
        ("LINE SEPARATOR U+2028", '\u{2028}'),
        ("PARAGRAPH SEPARATOR U+2029", '\u{2029}'),
        ("SPACE U+0020", ' '),
    ] {
        assert!(is_invisible_prefix(ch), "{label} must be in the class");
        let input = format!("{ch}=cmd");
        let got = escape_csv_cell(&input, &CsvCellOptions::default());
        assert_eq!(got, format!("'{input}"), "{label} must not hide a trigger");
    }

    // TAB is NOT in the class: it is itself a trigger, so skipping past it
    // would un-guard "\t=cmd" — the exact trap `\s` would have walked into.
    assert!(!is_invisible_prefix('\t'), "TAB must stay a trigger, not a skip");
}

/// The shared fixture's "DEFAULT OPTIONS" vectors pin the TypeScript default
/// against `escape_csv_cell`'s default. They cannot see `csv.rs::escape`, which
/// spells its options out so a NEW option cannot be inherited silently, and so
/// does NOT follow the shared default automatically.
///
/// `csv::tests::escape_exempts_a_wholly_numeric_cell_and_guards_everything_else`
/// pins what that writer does. This pins the value it is hard-coded to, so a
/// coordinated flip of the product policy -- both language defaults to `false`,
/// fixture updated -- fails here instead of leaving the Rust exporter exempting
/// while every TypeScript writer guards.
#[test]
fn the_csv_exporters_hard_coded_option_still_matches_the_shared_default() {
    assert!(
        CsvCellOptions::default().exempt_numbers,
        "rust/export/src/csv.rs hard-codes `exempt_numbers: true`; the shared \
         default has moved away from it, so that exporter and every TypeScript \
         writer no longer agree"
    );
}
