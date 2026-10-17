// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5266: the same cases `isCompleteStepNumericLiteral` pins on the
//! TypeScript side (#5193), so the two grammars cannot drift apart.

use super::{parse_step_numeric, step_numeric_literal_len};

#[test]
fn accepts_every_legal_real_and_integer_form() {
    for (text, value) in [
        ("1.", 1.0),
        (".5", 0.5),
        ("1.E3", 1000.0),
        ("+1.5", 1.5),
        ("123", 123.0),
        ("-3", -3.0),
        ("1.5e-2", 0.015),
    ] {
        assert_eq!(step_numeric_literal_len(text.as_bytes()), Some(text.len()), "{text}");
        assert_eq!(parse_step_numeric::<f64>(text.as_bytes()), Some((value, text.len())), "{text}");
    }
    // Grammatically complete even though f64 cannot hold it: overflow is a
    // separate question from whether the token is a literal.
    assert_eq!(step_numeric_literal_len(b"1.0E400"), Some(7));
}

#[test]
fn stops_at_every_byte_that_may_follow_a_list_item() {
    for tail in [",2.", ")", " ,", "\t)", "/* c */,"] {
        let input = format!("1.5{tail}");
        assert_eq!(step_numeric_literal_len(input.as_bytes()), Some(3), "{input:?}");
    }
}

#[test]
fn refuses_a_corrupted_literal_instead_of_reading_its_prefix() {
    for text in ["1.52.3", "1.5abc", "1.52.3,4.", "3.x)", "1.5/", "1.5-2"] {
        assert_eq!(step_numeric_literal_len(text.as_bytes()), None, "{text}");
        assert_eq!(parse_step_numeric::<f64>(text.as_bytes()), None, "{text}");
    }
}

#[test]
fn refuses_non_step_float_spellings_fast_float_would_accept() {
    for text in ["nan", "NaN", "inf", "-inf", "infinity", "Infinity"] {
        assert_eq!(step_numeric_literal_len(text.as_bytes()), None, "{text}");
    }
}

#[test]
fn refuses_a_sign_or_dot_with_no_digit_and_an_empty_exponent() {
    for text in ["", "+", "-", ".", "+.", "1.E", "1.E+", "1e-)"] {
        assert_eq!(step_numeric_literal_len(text.as_bytes()), None, "{text:?}");
    }
}

/// #7678 (S6a): a literal the target type cannot hold is refused, not read as
/// an infinity. STEP has no NaN or infinity spelling, so overflow is the only
/// way a decoded REAL can be non-finite. `-0.` keeps its sign bit and an
/// underflowing literal still reads as zero.
#[test]
fn refuses_a_literal_its_target_type_cannot_hold() {
    for text in ["1.0E400", "-1.0E400", "1.E309", "1.8E308", "9.E999"] {
        assert_eq!(parse_step_numeric::<f64>(text.as_bytes()), None, "f64 {text}");
        assert_eq!(parse_step_numeric::<f32>(text.as_bytes()), None, "f32 {text}");
    }
    // Finite in f64, infinite in the f32 the coordinate fast paths read into.
    assert_eq!(parse_step_numeric::<f32>(b"1.E39"), None);
    assert_eq!(parse_step_numeric::<f64>(b"1.E39"), Some((1.0e39, 5)));
    // The largest finite values of each type are still admitted.
    assert_eq!(parse_step_numeric::<f64>(b"1.7976931348623157E308"), Some((f64::MAX, 22)));
    assert_eq!(parse_step_numeric::<f32>(b"3.4028235E38"), Some((f32::MAX, 12)));
}

#[test]
fn admits_negative_zero_and_underflow() {
    for text in ["-0.", "-0.0", "-0.E0", "-0"] {
        let (v, _) = parse_step_numeric::<f64>(text.as_bytes()).expect(text);
        assert!(v == 0.0 && v.is_sign_negative(), "{text}: {v:?}");
        let (v, _) = parse_step_numeric::<f32>(text.as_bytes()).expect(text);
        assert!(v == 0.0 && v.is_sign_negative(), "f32 {text}: {v:?}");
    }
    assert_eq!(parse_step_numeric::<f64>(b"1.E-400"), Some((0.0, 7)));
    assert_eq!(parse_step_numeric::<f32>(b"1.E-50"), Some((0.0, 6)));
}
