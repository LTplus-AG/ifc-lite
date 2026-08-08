// SPDX-License-Identifier: MPL-2.0
//! STEP text-level primitives shared by the STEP exporter (`step.rs`): string
//! escaping, header `FILE_SCHEMA` detection, `#ref` scanning, and the
//! attribute-list splitting used to apply root-attribute mutations.
//!
//! Split out of `step.rs` to keep that file under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`). These are self-contained
//! line/string utilities with no dependency on the DATA-section emission
//! orchestration that stays in `step.rs`.

/// Escape a STEP string literal body: double the apostrophe and reverse
/// solidus, and map every ASCII control character (the C0 range plus DEL) to
/// a space, since ISO 10303-21 restricts a literal's plain-text bytes to the
/// basic graphic range 32-126.
pub(crate) fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            // ISO 10303-21 doubles both the apostrophe and the reverse
            // solidus inside a string literal; each is independent of the
            // other (order in the source string is preserved as-is).
            '\'' => out.push_str("''"),
            '\\' => out.push_str("\\\\"),
            '\0'..='\u{1F}' | '\u{7F}' => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}

/// Find the first occurrence of `needle` in `haystack` that is *not* inside a
/// STEP single-quoted string literal — i.e. skip matches that fall within a
/// header field's string value. Quote state is tracked by toggling on every
/// `'` byte; a literal apostrophe inside a string is escaped by doubling
/// (`''` per ISO 10303-21 6.3.2.4), so a doubled pair toggles the state twice
/// and correctly nets to a no-op, the same technique `refs_in_line` already
/// uses above for `#`-reference scanning. Linear in `haystack.len()` — no
/// backtracking, no regex.
fn find_unquoted(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let mut in_quote = false;
    let mut i = 0;
    let last_start = haystack.len() - needle.len();
    while i < haystack.len() {
        if haystack[i] == b'\'' {
            in_quote = !in_quote;
            i += 1;
            continue;
        }
        if !in_quote && i <= last_start && haystack[i..i + needle.len()] == *needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Detect the source `FILE_SCHEMA` label (e.g. `IFC2X3`); defaults to `IFC4`.
pub(crate) fn detect_schema(content: &[u8]) -> String {
    // Only look in the header region: from the start through the HEADER
    // section's closing `ENDSEC;`. A fixed byte cutoff is not safe here —
    // an earlier header field (e.g. a long DESCRIPTION or AUTHOR string)
    // can push FILE_SCHEMA past any fixed budget, silently falling back to
    // the IFC4 default and applying the wrong schema conversion. Scan for
    // the actual section terminator instead; if it's missing (malformed
    // input), fall back to scanning the whole buffer.
    //
    // Both this ENDSEC; search and the FILE_SCHEMA search below must be
    // quote-aware: a header field's plain-text string VALUE (e.g. a
    // DESCRIPTION or AUTHOR carrying the literal text "ENDSEC;" or
    // "FILE_SCHEMA") is not the section terminator or the schema entry, and
    // a raw byte search cannot tell the difference.
    let head_len = find_unquoted(content, b"ENDSEC;")
        .map(|idx| idx + b"ENDSEC;".len())
        .unwrap_or(content.len());
    let head = &content[..head_len];
    if let Some(idx) = find_unquoted(head, b"FILE_SCHEMA") {
        let rest = String::from_utf8_lossy(&head[idx..]);
        if let Some(q1) = rest.find('\'') {
            if let Some(q2) = rest[q1 + 1..].find('\'') {
                let label = &rest[q1 + 1..q1 + 1 + q2];
                if !label.is_empty() {
                    return label.to_string();
                }
            }
        }
    }
    "IFC4".to_string()
}

/// Collect outgoing `#<digits>` references in a STEP entity line, skipping the
/// contents of single-quoted strings (where a `#` is literal text).
pub(crate) fn refs_in_line(line: &[u8], out: &mut Vec<u32>) {
    let mut i = 0;
    let mut in_quote = false;
    while i < line.len() {
        let b = line[i];
        if b == b'\'' {
            // STEP escapes a quote as '' — toggling twice is a no-op, which is fine.
            in_quote = !in_quote;
            i += 1;
            continue;
        }
        if !in_quote && b == b'#' {
            let mut j = i + 1;
            let mut n: u32 = 0;
            let mut any = false;
            while j < line.len() && line[j].is_ascii_digit() {
                n = n.wrapping_mul(10).wrapping_add((line[j] - b'0') as u32);
                j += 1;
                any = true;
            }
            if any {
                out.push(n);
                i = j;
                continue;
            }
        }
        i += 1;
    }
}

/// Split a STEP attribute list into its top-level arguments (parens/strings aware).
fn split_top_level_args(attrs: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut current = String::new();
    let bytes = attrs.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i] as char;
        if ch == '\'' && !in_string {
            in_string = true;
            current.push(ch);
        } else if ch == '\'' && in_string {
            if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                current.push_str("''");
                i += 2;
                continue;
            }
            in_string = false;
            current.push(ch);
        } else if in_string {
            current.push(ch);
        } else if ch == '(' {
            depth += 1;
            current.push(ch);
        } else if ch == ')' {
            depth -= 1;
            current.push(ch);
        } else if ch == ',' && depth == 0 {
            out.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
        i += 1;
    }
    out.push(current);
    out
}

/// Apply root-attribute edits to a `#id=TYPE(attrs);` line. Returns the line unchanged
/// when it cannot be parsed.
pub(crate) fn apply_attr_mutations(line: &str, muts: &[(usize, String)]) -> String {
    let trimmed = line.trim_end();
    let body = trimmed.strip_suffix(';').unwrap_or(trimmed);
    let eq = match body.find('=') {
        Some(e) => e,
        None => return line.to_string(),
    };
    let after = &body[eq + 1..];
    let popen = match after.find('(') {
        Some(p) => p,
        None => return line.to_string(),
    };
    let aclose = match after.rfind(')') {
        Some(c) if c > popen => c,
        _ => return line.to_string(),
    };
    let prefix = &body[..=eq];
    let type_name = &after[..popen];
    let mut args = split_top_level_args(&after[popen + 1..aclose]);
    for (idx, val) in muts {
        if *idx < args.len() {
            args[*idx] = val.clone();
        }
    }
    format!("{prefix}{type_name}({});", args.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_schema_finds_file_schema_past_the_old_4096_byte_cutoff() {
        // `detect_schema` used to scan only the first 4096 bytes looking for
        // `FILE_SCHEMA`. A real STEP header can push FILE_SCHEMA past that
        // point when an earlier header field (e.g. DESCRIPTION) carries long
        // text. Pad the header well past 4096 bytes before FILE_SCHEMA and
        // confirm the schema is still found instead of silently falling back
        // to the `IFC4` default.
        let padding = "x".repeat(5000);
        let content = format!(
            "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('{padding}'),'2;1');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"
        );
        assert!(
            content.len() > 4096,
            "test fixture must exceed the old 4096-byte cutoff"
        );
        assert_eq!(detect_schema(content.as_bytes()), "IFC2X3");
    }

    #[test]
    fn detect_schema_ignores_endsec_literal_text_inside_a_quoted_string() {
        // Bug: the header-end scan for `ENDSEC;` was a raw byte search with
        // no quote awareness. A header field whose string VALUE happens to
        // contain the literal text `ENDSEC;` truncates the header early,
        // before the real FILE_SCHEMA entry is ever reached, silently
        // falling back to the IFC4 default.
        let content =
            "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('note: not an ENDSEC; marker'),'2;1');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"
                .to_string();
        assert_eq!(detect_schema(content.as_bytes()), "IFC2X3");
    }

    #[test]
    fn detect_schema_ignores_file_schema_literal_text_inside_a_quoted_string() {
        // Bug: the FILE_SCHEMA locate was also a raw byte search with no
        // quote awareness. A header field whose string VALUE embeds the
        // literal text `FILE_SCHEMA` before the real entry causes the scan
        // to match inside the quoted field instead, and the quote-hunt that
        // follows picks up the wrong (or no) label.
        let content =
            "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('mentions FILE_SCHEMA in passing'),'2;1');\nFILE_SCHEMA(('IFC4X3'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"
                .to_string();
        assert_eq!(detect_schema(content.as_bytes()), "IFC4X3");
    }

    #[test]
    fn detect_schema_handles_doubled_apostrophe_escape_before_the_real_endsec() {
        // A header field value containing a literal apostrophe, escaped per
        // ISO 10303-21 by doubling (`''`), must not desynchronize the
        // quote-tracking scanner's in/out-of-string state. Wrong parity here
        // would (depending on direction) either treat real header text as
        // still-quoted or treat the ENDSEC;/FILE_SCHEMA text that follows as
        // quoted, and either way defeat the fix.
        let content =
            "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('O''Brien''s model'),'2;1');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"
                .to_string();
        assert_eq!(detect_schema(content.as_bytes()), "IFC2X3");
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
    fn escape_no_special_chars_is_byte_identical() {
        // Bounding control: plain ASCII with no quote/backslash/control chars
        // must pass through unchanged (no spurious allocation-visible diff).
        for s in ["plain", "IFC4", "Pset_WallCommon", "123-abc_DEF"] {
            assert_eq!(escape(s), s);
        }
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

        fn fixture(rel: &str) -> Vec<u8> {
            let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
            std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
        }

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

        let src = fixture("ara3d/duplex.ifc");
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

}
