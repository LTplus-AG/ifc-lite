// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for #1579: `EntityScanner::find_entity_end` was rewritten from a
//! per-byte scalar walk to a `memchr2` SIMD scan. Its contract must stay
//! byte-identical: a record ends at the first `;` that is OUTSIDE a quoted
//! string, and a doubled `''` inside a string is an escaped quote, not a close.
//! These cases are exercised through the public `build_entity_index` so the
//! record boundaries (byte spans) are asserted end to end. An off-by-one in the
//! terminator scan would split a record at an in-string `;` and mis-index the
//! following entity.

use ifc_lite_core::build_entity_index;

#[test]
fn in_string_semicolons_and_escaped_quotes_do_not_terminate_a_record() {
    // #1's string contains a bare ';', an escaped '' and another ';'. If the
    // scanner stopped at the inner ';', #1's span would be truncated and #2
    // would be mis-indexed.
    let content = b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
#1=IFCLABEL('a;b '' c;d');\n\
#2=IFCTEXT('plain');\n\
ENDSEC;\nEND-ISO-10303-21;\n";

    let idx = build_entity_index(content);
    assert!(idx.contains_key(&1), "entity #1 must be indexed");
    assert!(idx.contains_key(&2), "entity #2 must be indexed");

    // #1's byte span must reach the REAL terminator (after the closing quote),
    // so the whole in-string payload is contained.
    let (s1, e1) = idx[&1];
    let rec1 = std::str::from_utf8(&content[s1..e1]).unwrap();
    assert!(
        rec1.contains("c;d')"),
        "record #1 was terminated early at an in-string ';': {rec1:?}"
    );
    assert!(
        rec1.trim_end().ends_with(';'),
        "record #1 must end at the record-terminating ';': {rec1:?}"
    );

    // #2 must be the plain text record, proving the scan resumed correctly
    // after #1's string closed.
    let (s2, e2) = idx[&2];
    let rec2 = std::str::from_utf8(&content[s2..e2]).unwrap();
    assert!(rec2.contains("IFCTEXT('plain')"), "record #2 wrong: {rec2:?}");
}

#[test]
fn trailing_escaped_quote_at_string_end_still_finds_the_terminator() {
    // The closing quote is immediately preceded by an escaped '' (three quotes
    // `'''`: one escaped pair that decodes to a literal quote, then the real
    // close). The scanner must consume the escape, recognize the true closing
    // quote, then find the terminating ';'. A boundary bug here would run the
    // string on and miss #2. Decoded value of #1 is `ab'`.
    let content = b"DATA;\n#1=IFCLABEL('ab''');\n#2=IFCLABEL('next');\nENDSEC;\n";
    let idx = build_entity_index(content);
    assert!(idx.contains_key(&1), "entity #1 must be indexed");
    assert!(idx.contains_key(&2), "entity #2 must be indexed");
    let (s2, e2) = idx[&2];
    assert!(
        std::str::from_utf8(&content[s2..e2]).unwrap().contains("'next'"),
        "record #2 mis-indexed after a trailing escaped quote"
    );
}
