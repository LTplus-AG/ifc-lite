// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[test]
fn step_string_literal_end_keeps_page_operands_inside_7589() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../tests/fixtures/step-page-directive.json"
    ))
    .unwrap();
    for vector in vectors.as_array().unwrap() {
        let literal = vector["literal"].as_str().unwrap();
        let text = format!("({literal},'next')");
        assert_eq!(super::step_string_literal_end(text.as_bytes(), 1), Some(1 + literal.len()), "{}", vector["name"]);
    }
    assert_eq!(super::step_string_literal_end(br"('a\S\'", 1), None);
    assert_eq!(super::step_string_literal_end(b"('it''", 1), None);
}

#[test]
fn no_backslash_is_borrowed_and_unchanged() {
    assert!(matches!(decode_ifc_string("Hello World"), Cow::Borrowed(_)));
    // A typical base64 IFC GUID contains no backslash.
    assert_eq!(decode_ifc_string("3Bvg7$qHb0gP37$Qz2vN1k"), "3Bvg7$qHb0gP37$Qz2vN1k");
}

#[test]
fn decodes_x2_bmp() {
    assert_eq!(decode_ifc_string(r"Br\X2\00FC\X0\cke"), "Br\u{FC}cke");
}

#[test]
fn decodes_x2_surrogate_pair() {
    assert_eq!(decode_ifc_string(r"\X2\D83DDE00\X0\"), "\u{1F600}");
}

#[test]
fn decodes_x4_astral() {
    assert_eq!(decode_ifc_string(r"\X4\0001F600\X0\"), "\u{1F600}");
}

#[test]
fn decodes_x_and_s() {
    assert_eq!(decode_ifc_string(r"\X\E9"), "\u{E9}");
    assert_eq!(decode_ifc_string(r"\S\a"), "\u{E1}");
}

#[test]
fn drops_code_page_directive() {
    assert_eq!(decode_ifc_string(r"\PA\Hello"), "Hello");
}

#[test]
fn collapses_the_doubled_reverse_solidus() {
    // ISO 10303-21 doubles the reverse solidus inside a string literal just
    // as it doubles the apostrophe, so the pair is ONE backslash (#2323).
    assert_eq!(decode_ifc_string(r"C:\\temp"), r"C:\temp");
    // Two escaped backslashes stay two: exactly one collapsing pass.
    assert_eq!(decode_ifc_string(r"\\\\"), r"\\");
    // A directive consumes its own \X0\ terminator before the pair escape is
    // considered, so a trailing escaped backslash survives whole.
    assert_eq!(decode_ifc_string("\\X2\\00FC\\X0\\\\\\"), "\u{FC}\\");
    // Mirror case: a leading escaped backslash makes the rest literal text.
    assert_eq!(decode_ifc_string(r"\\X2\00FC\X0\"), r"\X2\00FC\X0\");
}

#[test]
fn keeps_unknown_escape() {
    assert_eq!(decode_ifc_string(r"a\Qb"), r"a\Qb");
    // Malformed (no terminator) is passed through, not panicked on.
    assert_eq!(decode_ifc_string(r"\X2\00FC"), r"\X2\00FC");
}

#[test]
fn s_escape_before_multibyte_char_does_not_panic() {
    // A malformed `\S\` followed by a multi-byte UTF-8 char must not leave
    // the cursor mid-character (previously panicked via a non-boundary
    // slice, aborting the whole wasm instance under panic=abort).
    let _ = decode_ifc_string("\\S\\\u{00E9}tail");
    let _ = decode_ifc_string("x\\S\\\u{1F600}y");
    // The canonical single-ASCII form is unchanged.
    assert_eq!(decode_ifc_string(r"\S\a"), "\u{E1}");
}

#[test]
fn s_escape_honours_the_selected_code_page() {
    // ISO 10303-21 6.4.3: \PE\ selects ISO 8859-5 (Cyrillic). Before
    // codepage tracking, every \S\ was decoded as if the default page
    // (ISO 8859-1) were active, giving U+00D0 (LATIN CAPITAL LETTER ETH)
    // instead of the correct U+0430 (CYRILLIC SMALL LETTER A).
    assert_eq!(decode_ifc_string(r"\PE\\S\P"), "\u{0430}");
    // The page persists across multiple \S\ escapes in the same string...
    assert_eq!(decode_ifc_string(r"\PE\\S\P\S\Q"), "\u{0430}\u{0431}");
    // ...until another \P?\ directive switches it again.
    assert_eq!(decode_ifc_string(r"\PE\\S\P\PA\\S\P"), "\u{0430}\u{00D0}");
    // A byte position ISO 8859-6 (Arabic, \PF\) itself leaves unassigned
    // falls back to the raw code point rather than U+FFFD.
    assert_eq!(decode_ifc_string(r"\PF\\S\0"), "\u{00B0}");
}

/// D18 (F4-1): one byte decoder for STEP binaries, with or without the
/// quotes, both hex cases. A non-zero unused-bits indicator, an odd digit
/// count and a non-hex byte are refused, not read as a prefix.
#[test]
fn decode_step_binary_refuses_what_it_cannot_decode_exactly() {
    assert_eq!(decode_step_binary(b"0FF000a"), Some(vec![0xFF, 0x00, 0x0A]));
    assert_eq!(decode_step_binary(b"\"0Ff00\""), Some(vec![0xFF, 0x00]));
    assert_eq!(decode_step_binary(b"0"), Some(vec![]));
    for refused in [&b""[..], b"\"\"", b"1FF", b"3F0", b"4FF", b"0F", b"0FG0", b"0FF "] {
        assert_eq!(decode_step_binary(refused), None, "{refused:?}");
    }
}

/// CORE-16: one funnel for "literal bytes to text". Quotes off, `''`
/// undoubled, THEN the backslash directives; borrowed when there is
/// nothing to undo.
#[test]
fn decode_step_literal_is_the_one_literal_funnel() {
    assert_eq!(decode_step_literal(b"'O''Brien'").as_deref(), Some("O'Brien"));
    assert_eq!(decode_step_literal(br"'Br\X2\00FC\X0\cke'").as_deref(), Some("Br\u{FC}cke"));
    assert_eq!(decode_step_literal(b"''").as_deref(), Some(""));
    // The order is load-bearing: two escaped apostrophes stay two.
    assert_eq!(decode_step_literal(br"'\X\27\X\27'").as_deref(), Some("''"));
    assert!(matches!(decode_step_literal(b"'plain'"), Some(Cow::Borrowed("plain"))));
    for not_a_literal in [&b"'"[..], b"", b"abc", b"'abc", b"abc'", b"\"abc\""] {
        assert_eq!(decode_step_literal(not_a_literal), None, "{not_a_literal:?}");
    }
    // Not UTF-8: lossy, as the token converter always was.
    assert_eq!(decode_step_literal(b"'a\xFFb'").as_deref(), Some("a\u{FFFD}b"));
}

/// CORE-28: every unterminated `\X2\` / `\X4\` opener searched to the end of
/// the input for its `\X0\`, so N openers cost N times the input. The
/// 240 KB input below took seconds on the old search and takes
/// milliseconds on the memoised one; the bound is 100x the fixed cost.
#[test]
fn unterminated_x2_openers_do_not_rescan_the_input_28() {
    for opener in ["\\X2\\", "\\X4\\"] {
        let hostile = format!("{opener} ").repeat(60_000);
        let started = std::time::Instant::now();
        assert_eq!(decode_ifc_string(&hostile), hostile.as_str());
        assert!(hostile.len() > 240_000);
        assert!(started.elapsed().as_secs() < 2, "{opener}: {:?}", started.elapsed());
    }
    // A terminator past many failed openers is still found for the one
    // that pairs with it, and the openers before it stay text.
    assert_eq!(decode_ifc_string("\\X2\\zz\\X2\\00FC\\X0\\"), "\\X2\\zz\u{FC}");
}
