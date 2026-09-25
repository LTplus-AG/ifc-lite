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
