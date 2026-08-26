// SPDX-License-Identifier: MPL-2.0
//! Tests for `step_text.rs`, split out under the house pattern (AGENTS.md).
//!
//! Moved out so the production module stays under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`); this file is exempt via
//! the `_tests.rs` suffix convention.

use super::*;











/// End-to-end scenario for the same seam through the real `export_step`
/// path: a source file whose `FILE_SCHEMA` label carries a literal `\`,
/// exported with no explicit target schema (so `step.rs:196` falls back to
/// `source_schema` and `step.rs:217` re-escapes it), must round-trip the
/// label instead of compounding the escape.
#[test]
fn export_step_round_trips_a_backslash_carrying_schema_label_through_source_schema_fallback() {
    use crate::step::{export_step_with_stats, StepOptions};

    let source = b"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC\\\\4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";

    let (step, _stats) = export_step_with_stats(source, &StepOptions::default());
    let schema_line = step
        .lines()
        .find(|l| l.starts_with("FILE_SCHEMA("))
        .expect("a FILE_SCHEMA header line");
    assert_eq!(
        schema_line, "FILE_SCHEMA(('IFC\\\\4'));",
        "source schema label must round-trip, not compound its escaping"
    );
}

#[test]
fn split_top_level_args_respects_nesting() {
    let args = "'a',$,(#1,#2,#3),IFCBOOLEAN(.T.),#9";
    let parts = split_top_level_args(args);
    assert_eq!(parts.len(), 5);
    assert_eq!(parts[2], "(#1,#2,#3)");
    assert_eq!(parts[3], "IFCBOOLEAN(.T.)");
}

/// ISO 10303-21 doubles two characters inside a string literal: the
/// apostrophe (already handled) and the reverse solidus (the bug this
/// pins). `escape()` is the single funnel every STEP string literal in
/// this exporter goes through, so this test is the RED/GREEN pin for the
/// write-side half of the doubling-escape gap.
#[test]
fn escape_doubles_backslash_like_apostrophe() {
    assert_eq!(escape(r"C:\temp"), r"C:\\temp");
    assert_eq!(escape(r"a\b\c"), r"a\\b\\c");
}

#[test]
fn escape_doubles_both_escapes_in_the_same_string_in_source_order() {
    // A name carrying both a literal apostrophe and a literal backslash,
    // in each relative order, must come out with each doubled exactly
    // where it occurred — not reordered, not merged.
    assert_eq!(escape(r"O'Brien\Docs"), r"O''Brien\\Docs");
    assert_eq!(escape(r"\Docs\O'Brien"), r"\\Docs\\O''Brien");
}

#[test]
fn escape_maps_every_ascii_control_char_to_a_space() {
    // ISO 10303-21 restricts a string literal's literal bytes to the
    // basic graphic range 32-126; anything below that (or DEL, 127) is
    // not a legal literal byte in the file. `escape()` already maps
    // '\n' / '\r' / '\t' to a space; this pins that the same treatment
    // applies to every other C0 control byte and DEL, not just those
    // three. NUL, vertical tab (0x0B), unit separator (0x1F), and DEL
    // (0x7F) are direct reproductions of CodeRabbit's finding on #2405.
    for c in ['\0', '\u{0B}', '\u{1F}', '\u{7F}'] {
        let s = format!("a{c}b");
        assert_eq!(
            escape(&s),
            "a b",
            "control char {:#04x} was not mapped to a space",
            c as u32
        );
    }
}

#[test]
fn escape_preserves_the_length_of_a_control_char_run() {
    // The single-char cases above pass identically whether `escape` replaces
    // per character or collapses a run, so they cannot see the difference
    // #3284 is about, and this side's rule was never actually asserted.
    //
    // That mattered: the two TypeScript escapers carried `[\x00-\x1F\x7F]+`,
    // so `"a\t\t\tb"` was written as `'a b'` there and `'a   b'` here, one
    // nominal rule with two behaviours, and every test on both sides stayed
    // green because none of them used a run. #3294 fixes the TypeScript half.
    // This pins the half it is being made to agree with, so the agreement
    // rests on a test rather than on two doc comments citing each other.
    assert_eq!(escape("a\t\t\tb"), "a   b");
    assert_eq!(escape("\0\0\0"), "   ");
    // Mixed kinds in one run: still one space each, not one for the run.
    assert_eq!(escape("a\r\n\u{0B}\u{7F}b"), "a    b");
}

#[test]
fn escape_no_special_chars_is_byte_identical() {
    // Bounding control: plain ASCII with no quote/backslash/control chars
    // must pass through unchanged (no spurious allocation-visible diff).
    for s in ["plain", "IFC4", "Pset_WallCommon", "123-abc_DEF"] {
        assert_eq!(escape(s), s);
    }
}

#[test]
fn escape_encodes_non_ascii_as_x2_directive_not_raw_utf8() {
    // ISO 10303-21 6.3.3.4 restricts a string literal's plain-text bytes to
    // the basic graphic range 32-126 — the same clause the doc comment above
    // `escape()` already cites for control chars. A byte outside that range
    // must be a control directive (`\X\HH`, `\X2\HHHH\X0\`, `\X4\HHHHHHHH\X0\`),
    // never a raw byte; buildingSMART's IFC string-encoding guidance says the
    // same for IFC2X3/IFC4/IFC4X3. `ifc_lite_core::encode_ifc_string` already
    // implements this correctly but was never wired into this writer, so a
    // BMP or non-BMP character in a name/label went out as raw UTF-8 — bytes
    // a reader that (correctly, per spec) treats the file as ISO-8859-1 turns
    // into mojibake or a broken parse. Matches the TS-side fix in
    // `@ifc-lite/export`'s `escapeStepString`.
    assert_eq!(escape("Trümpler"), r"Tr\X2\00FC\X0\mpler");
    assert_eq!(escape("😀"), r"\X4\0001F600\X0\");
}
/// End-to-end write-side round-trip for the ISO 10303-21 doubling escapes.
///
/// ifc-lite's own reader (`ifc_lite_core::step_encoding::decode_ifc_string`
/// / the tokenizer) does not yet collapse `''` or `\\` on this branch — that
/// half is tracked separately and lands on its own branch, not here. So
/// this test does not round-trip through ifc-lite's reader (that would
/// conflate two different bugs); instead it applies the ISO 10303-21 spec
/// rule directly — the STEP standard's un-doubling, independent of what
/// any particular reader currently implements — to the raw bytes this
/// exporter wrote, and asserts the original string comes back. That is
/// the write side's actual contract: emit a spec-conformant file.
#[test]
fn property_synthesis_round_trips_apostrophe_and_backslash_per_spec() {
    use crate::step::{export_step_with_stats, PropMutation, StepOptions};
    use ifc_lite_core::EntityScanner;

    // A STRICT ISO 10303-21 6.3.2.4/6.3.2.5 un-escaper: every literal `'`
    // and `\` in the string's plain-text value MUST appear doubled in the
    // literal. A run of backslashes with an ODD length is malformed under
    // that rule (an un-doubled backslash is not distinguishable from the
    // start of some other escape directive) — a real conformant reader is
    // entitled to reject it, so this panics rather than silently passing
    // it through. That is what makes this test discriminating: a writer
    // that forgets to double `\` produces odd-length runs here, not a
    // string that "happens to" spec-unescape back to the original.
    fn spec_unescape(quoted_body: &str) -> String {
        let mut out = String::with_capacity(quoted_body.len());
        let bytes = quoted_body.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'\'' {
                assert_eq!(
                    bytes.get(i + 1),
                    Some(&b'\''),
                    "malformed STEP literal: un-doubled apostrophe at byte {i} in {quoted_body:?}"
                );
                out.push('\'');
                i += 2;
            } else if bytes[i] == b'\\' {
                let mut run = 0usize;
                while bytes.get(i + run) == Some(&b'\\') {
                    run += 1;
                }
                assert_eq!(
                    run % 2,
                    0,
                    "malformed STEP literal: odd-length ({run}) backslash run at byte {i} in {quoted_body:?} — a real reader can't tell whether this is a doubled reverse solidus or the start of an escape directive"
                );
                for _ in 0..run / 2 {
                    out.push('\\');
                }
                i += run;
            } else {
                out.push(bytes[i] as char);
                i += 1;
            }
        }
        out
    }

    let src = fixture_or_skip!("ara3d/duplex.ifc");
    let mut scanner = EntityScanner::new(&src[..]);
    let mut wall = None;
    while let Some((id, t, _s, _e)) = scanner.next_entity() {
        if t.eq_ignore_ascii_case("IFCWALLSTANDARDCASE") {
            wall = Some(id);
            break;
        }
    }
    let wall = wall.expect("a wall");

    let original_pset_name = r"O'Brien\Docs\Pset";
    let (step, _stats) = export_step_with_stats(
        &src,
        &StepOptions {
            property_mutations: vec![PropMutation {
                express_id: wall,
                pset_name: original_pset_name.to_string(),
                prop_name: "MyProp".to_string(),
                value: "IFCLABEL('hello')".to_string(),
            }],
            ..StepOptions::default()
        },
    );

    // Locate the synthesized IFCPROPERTYSET line and pull its (still-quoted)
    // name field: `IFCPROPERTYSET('<guid>',$,'<pset_name>',$,(...))` — the
    // NAME is the second quoted field, after the placeholder GUID.
    let pset_line = step
        .lines()
        .find(|l| l.contains("=IFCPROPERTYSET(") && l.contains("Brien"))
        .expect("synthesized pset line present");

    // Scan quoted-string fields left to right (skipping doubled '' pairs
    // inside each), returning the raw body between the Nth pair of quotes.
    fn nth_quoted_body(line: &str, n: usize) -> &str {
        let bytes = line.as_bytes();
        let mut i = 0;
        let mut found = 0;
        while i < bytes.len() {
            if bytes[i] == b'\'' {
                let start = i + 1;
                let mut j = start;
                loop {
                    if bytes[j] == b'\'' {
                        if bytes.get(j + 1) == Some(&b'\'') {
                            j += 2;
                            continue;
                        }
                        break;
                    }
                    j += 1;
                }
                if found == n {
                    return &line[start..j];
                }
                found += 1;
                i = j + 1;
            } else {
                i += 1;
            }
        }
        panic!("fewer than {n} quoted fields in: {line}");
    }
    let raw_quoted_body = nth_quoted_body(pset_line, 1);

    assert_eq!(
        spec_unescape(raw_quoted_body),
        original_pset_name,
        "raw written bytes {raw_quoted_body:?} must spec-un-escape back to the original"
    );
}

#[test]
fn the_comment_scan_stays_linear_on_hostile_input() {
    // The property, not the timing. Searching at every `/*` is quadratic: a
    // failing search runs to the end of the buffer, the caller advances one
    // byte, and the next `/*` repeats it. This side is handed whole uncapped
    // files by `detect_schema`, so it is the worse half.
    //
    // One failure proves no closer exists at or after any later position, and
    // the scan only moves forward, so at most one search can ever fail and none
    // should happen after it. Asserting the count pins that without a
    // wall-clock threshold that would flake on a loaded machine.
    //
    // `/*` repeated would OVERLAP into `*/` and terminate itself, so the opens
    // are spaced. The TypeScript twin of this test caught that fixture bug.
    let hostile = format!("HEADER;\n{}\nFILE_SCHEMA;", "/* ".repeat(1000));
    assert!(!hostile.contains("*/"));
    let mut lex = crate::source_header::Lex::new(hostile.as_bytes());
    let mut i = 0;
    while i < hostile.len() {
        match lex.skip_lexical_at(i) {
            Some(end) if end > i => i = end,
            _ => i += 1,
        }
    }
    assert_eq!(lex.searches, 1, "one failed search should silence the rest");

    // The memo must not fire early: 500 real comments, none unterminated, so
    // every search succeeds and each consumes a span the others do not.
    let packed = format!("HEADER;\n{}FILE_SCHEMA;", "/*x*/".repeat(500));
    let mut lex = crate::source_header::Lex::new(packed.as_bytes());
    let (mut i, mut skipped) = (0usize, 0u32);
    while i < packed.len() {
        match lex.skip_lexical_at(i) {
            Some(end) if end > i => {
                skipped += 1;
                i = end;
            }
            _ => i += 1,
        }
    }
    assert_eq!(skipped, 500);
    assert_eq!(lex.searches, 500);
}
