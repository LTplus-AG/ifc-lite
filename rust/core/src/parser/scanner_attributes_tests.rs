// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for [`super::nth_attribute_is_present`], the one per-attribute read.
//!
//! Two groups moved here when the rule got its one home (core review behind
//! #4577, finding 8): the `#1910` contract tests that lived beside the
//! `schema_helpers` copy, and the comment-trivia tests that lived beside the
//! `EntityScanner::has_non_null_attribute` copy. Both copies are gone; every
//! case below runs against the single function.

use super::nth_attribute_is_present;

// #1910 review follow-up: `nth_attribute_is_present` had no direct unit
// test — every existing reference was production use or an integration
// test exercising it incidentally. These pin the documented contract:
// "attribute at `index` (0-based, top-level — respects nested parens and
// quoted strings) is present and non-null (`$`)".

#[test]
fn nth_attribute_present_and_non_null_is_true() {
    let entity = b"#40=IFCBUILDINGSTOREY('guid',$,'Level 1',$,$,#18,#39,$,.ELEMENT.,0.);";
    // index 0: 'guid' — present, non-null.
    assert!(nth_attribute_is_present(entity, 0));
    // index 6: #39 (Representation) — present, non-null.
    assert!(nth_attribute_is_present(entity, 6));
}

#[test]
fn nth_attribute_dollar_is_false() {
    let entity = b"#40=IFCBUILDINGSTOREY('guid',$,'Level 1',$,$,#18,$,$,.ELEMENT.,0.);";
    // index 6: $ (Representation) — present but null.
    assert!(!nth_attribute_is_present(entity, 6));
    // index 1: $ (OwnerHistory) — same.
    assert!(!nth_attribute_is_present(entity, 1));
}

#[test]
fn nth_attribute_past_the_end_is_false() {
    let entity = b"#1=IFCWALL('guid',$,'Wall');";
    // Only 3 top-level attributes (indices 0..=2); index 10 doesn't exist.
    assert!(!nth_attribute_is_present(entity, 10));
}

#[test]
fn nth_attribute_empty_value_is_false() {
    // `,,` — the middle attribute is an empty token, not `$` and not a
    // value. An empty slot is absent.
    let entity = b"#1=IFCFOO('a',,'c');";
    assert!(!nth_attribute_is_present(entity, 1));
    // Confirm the neighbours parsed correctly around the empty slot.
    assert!(nth_attribute_is_present(entity, 0));
    assert!(nth_attribute_is_present(entity, 2));
}

#[test]
fn nth_attribute_nested_parens_are_not_top_level_commas() {
    // IFCPOLYLOOP((#20,#21,#22)) — the whole nested list is attribute 0;
    // the commas inside the inner parens must not be counted as top-level
    // separators, and there must be no attribute 1.
    let entity = b"#30=IFCPOLYLOOP((#20,#21,#22),$);";
    assert!(nth_attribute_is_present(entity, 0));
    assert!(!nth_attribute_is_present(entity, 1));
    assert!(!nth_attribute_is_present(entity, 2));
}

#[test]
fn nth_attribute_quoted_comma_and_paren_are_not_top_level() {
    // A quoted string containing both a comma and parens must not be
    // split on, nor have its parens counted toward nesting depth.
    let entity =
        b"#40=IFCBUILDINGSTOREY('guid',$,'Level 1, west (annex)',$);";
    assert!(nth_attribute_is_present(entity, 0)); // 'guid'
    assert!(!nth_attribute_is_present(entity, 1)); // $
    assert!(nth_attribute_is_present(entity, 2)); // the quoted string itself
    assert!(!nth_attribute_is_present(entity, 3)); // $
    // Nothing beyond attribute 3 — the embedded comma/parens didn't
    // fabricate extra attributes.
    assert!(!nth_attribute_is_present(entity, 4));
}

#[test]
fn nth_attribute_escaped_quote_stays_inside_the_string() {
    // STEP escapes an embedded `'` as `''`. The scanner must not treat
    // the escape as the string's closing quote.
    let entity = b"#1=IFCWALL('guid',$,'quo''te',$);";
    assert!(nth_attribute_is_present(entity, 2)); // 'quo''te'
    assert!(!nth_attribute_is_present(entity, 3)); // $
    // No phantom attribute 4 from mis-parsing the escape as a delimiter.
    assert!(!nth_attribute_is_present(entity, 4));
}

#[test]
fn nth_attribute_no_open_paren_is_false() {
    assert!(!nth_attribute_is_present(b"#1=IFCWALL;", 0));
}

#[test]
fn nth_attribute_no_close_paren_is_false() {
    assert!(!nth_attribute_is_present(b"#1=IFCWALL('guid'", 0));
}

#[test]
fn nth_attribute_reversed_boundary_is_false() {
    // `)` appears before `(` — must not panic or index out of bounds.
    assert!(!nth_attribute_is_present(b")(", 0));
    assert!(!nth_attribute_is_present(b"garbage)stuff(more", 0));
}

// ---------------------------------------------------------------------------
// Comments inside the argument list (#3673's follow-up note, #3734): the
// scanner's span is comment-aware, but the attribute read was still
// comment-blind. A comment preceding a `$` used to read as a non-null value,
// because the leading-whitespace skip stopped at the comment's own `/` rather
// than treating the comment as trivia too. These were written against the
// scanner method `has_non_null_attribute`; the rule now has one home.
// ---------------------------------------------------------------------------

#[test]
fn treats_a_comment_before_dollar_as_still_null() {
    let content = "#1=IFCWALL(/* c1 */ $);";
    assert!(!nth_attribute_is_present(content.as_bytes(), 0));
}

#[test]
fn treats_a_comment_before_a_value_as_non_null() {
    let content = "#1=IFCWALL(/* c1 */ 'a');";
    assert!(nth_attribute_is_present(content.as_bytes(), 0));
}

/// A comma inside a comment must not count as an attribute separator: the
/// real target attribute (index 1) is the `$` after the comment, not the
/// comment's own `b'` fragment.
#[test]
fn comma_inside_a_comment_does_not_split_attributes() {
    let content = "#1=IFCWALL('a', /* x, y */ $);";
    assert!(!nth_attribute_is_present(content.as_bytes(), 1));
}

/// A `$` written literally inside a comment must not fool the check the other
/// way: attribute 0 here is `'a'`, not the comment's `$`.
#[test]
fn dollar_inside_a_comment_is_comment_text() {
    let content = "#1=IFCWALL(/* was $ */ 'a');";
    assert!(nth_attribute_is_present(content.as_bytes(), 0));
}

/// Discriminating sibling of the fixture above (#3734): the real attribute 0
/// here IS `$`, so a scanner that failed to skip the comment and read its
/// literal `$` as the attribute value would answer `true`. Both fixtures
/// exercise a comment ahead of attribute 0 with a `$` inside it, but only
/// this one is false if the comment is not skipped, so the pair together
/// catches both a reader that ignores comments and one that reads their
/// content.
#[test]
fn dollar_inside_a_comment_before_a_real_null_attribute() {
    let content = "#1=IFCWALL(/* was $ */ $);";
    assert!(!nth_attribute_is_present(content.as_bytes(), 0));
}

#[test]
fn comment_free_records_unchanged() {
    let content = "#1=IFCWALL('a',$,5);";
    assert!(nth_attribute_is_present(content.as_bytes(), 0));
    assert!(!nth_attribute_is_present(content.as_bytes(), 1));
    assert!(nth_attribute_is_present(content.as_bytes(), 2));
}

// ---------------------------------------------------------------------------
// Where the two copies disagreed (core review behind #4577, finding 8). Each
// case below had a different answer from the scanner method and the
// `schema_helpers` function on `main`; the one rule answers each once.
// ---------------------------------------------------------------------------

/// A comment BEFORE the `(` is the one place the scanner method was still
/// comment-blind: a bare `memchr(b'(')` found the comment's paren, so every
/// attribute index shifted and attribute 0 read as `was IFCSLAB) */ ($`
/// (non-null) instead of `$`. Reverting the fix answers `true` here.
#[test]
fn a_comment_before_the_argument_list_does_not_open_it() {
    let commented = b"#1=IFCWALL /* (was IFCSLAB) */ ($,'a');";
    let plain = b"#1=IFCWALL($,'a');";
    for index in 0..3 {
        assert_eq!(
            nth_attribute_is_present(commented, index),
            nth_attribute_is_present(plain, index),
            "attribute {index} must read the same with and without the comment"
        );
    }
    assert!(!nth_attribute_is_present(commented, 0));
    assert!(nth_attribute_is_present(commented, 1));
}

/// A comment between the instance name and the `=`, or between the `=` and
/// the type name, is trivia too; a `(` inside either must not open the list.
#[test]
fn a_comment_in_the_record_head_is_trivia() {
    let record = b"#1 /* (a) */ = /* (b) */ IFCWALL($,'a');";
    assert!(!nth_attribute_is_present(record, 0));
    assert!(nth_attribute_is_present(record, 1));
}

/// The `schema_helpers` copy trimmed with `u8::is_ascii_whitespace`, which
/// excludes the vertical tab (0x0B), so `\x0b$\x0b` was a non-empty token
/// unequal to `$` and read as present. The STEP whitespace set (#3733)
/// includes it. Reverting the fix answers `true` for the `$` slot.
#[test]
fn every_step_whitespace_byte_is_trimmed_around_a_value() {
    for ws in ["\t", "\x0b", "\x0c", " ", "\r\n"] {
        let record = format!("#1=IFCWALL({ws}${ws},{ws}'a'{ws});");
        assert!(
            !nth_attribute_is_present(record.as_bytes(), 0),
            "a `$` padded with {ws:?} is still the null token"
        );
        assert!(
            nth_attribute_is_present(record.as_bytes(), 1),
            "a value padded with {ws:?} is still a value"
        );
        assert!(!nth_attribute_is_present(record.as_bytes(), 2));
    }
}

/// Representation (index 6) behind a commented-out earlier value, the shape
/// the prepasses ask about; the `schema_helpers` copy split the comment's `,`.
#[test]
fn a_comment_inside_the_argument_list_is_trivia_for_every_slot() {
    assert!(!nth_attribute_is_present(b"#1=IFCWALL('a', /* x, y */ $);", 2));
    let storey =
        b"#40=IFCBUILDINGSTOREY('guid',$,/* 'Level 1', */ $,$,$,#18,#39,$,.ELEMENT.,0.);";
    assert!(nth_attribute_is_present(storey, 6));
    assert!(!nth_attribute_is_present(storey, 7));
}

/// An unterminated comment or string leaves nothing after it certain, so the
/// slot is absent rather than read from inside the void.
#[test]
fn an_unterminated_comment_or_string_settles_nothing() {
    assert!(!nth_attribute_is_present(b"#1=IFCWALL(/* open 'a');", 0));
    assert!(!nth_attribute_is_present(b"#1=IFCWALL('a', /* open $);", 1));
    assert!(!nth_attribute_is_present(b"#1=IFCWALL('open,$);", 0));
    assert!(!nth_attribute_is_present(b"#1=IFCWALL('a',$,'open);", 0));
}
