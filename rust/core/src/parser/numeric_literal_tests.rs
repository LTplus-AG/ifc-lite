// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5266: the same cases `isCompleteStepNumericLiteral` pins on the
//! TypeScript side (#5193), so the two grammars cannot drift apart.

use super::{parse_step_numeric, parse_step_real, read_step_number, step_numeric_literal_len, StepNumber};
use serde_json::Value;
use std::cell::Cell;

thread_local! {
    /// Test-only probes of how `read_step_number` valued each REAL on this
    /// thread: in its grammar walk, or by handing the literal to `fast_float2`.
    /// Bumped from the reader under `cfg(test)` only.
    static VALUED_IN_WALK: Cell<u64> = const { Cell::new(0) };
    static VALUED_BY_FAST_FLOAT: Cell<u64> = const { Cell::new(0) };
}

/// Called by `read_step_number` (test builds only) for every admitted REAL.
pub(super) fn note_valuation(in_walk: bool) {
    let probe = if in_walk { &VALUED_IN_WALK } else { &VALUED_BY_FAST_FLOAT };
    probe.with(|count| count.set(count.get() + 1));
}

fn valuations() -> (u64, u64) {
    (VALUED_IN_WALK.with(Cell::get), VALUED_BY_FAST_FLOAT.with(Cell::get))
}

/// The vectors `packages/data/src/step-numeric-literal.test.ts` reads too.
fn vectors() -> Vec<Value> {
    serde_json::from_str(include_str!("../../tests/fixtures/step_numeric_vectors.json")).unwrap()
}

fn bits(row: &Value) -> u64 {
    u64::from_str_radix(row["bits"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap()
}

/// F4-1: the one reader gives every shared vector the same answer, bit for
/// bit, whether it is the whole input or followed by a list delimiter.
#[test]
fn read_step_number_agrees_with_every_shared_vector() {
    for row in vectors() {
        let text = row["text"].as_str().unwrap();
        for tail in ["", ",2.", ")", " /* c */"] {
            let input = format!("{text}{tail}");
            let got = read_step_number(input.as_bytes());
            match row["kind"].as_str().unwrap() {
                "integer" => {
                    let want: i64 = row["value"].as_str().unwrap().parse().unwrap();
                    assert_eq!(got, Some((StepNumber::Integer(want), text.len())), "{input:?}");
                }
                "real" => {
                    let Some((StepNumber::Real(v), len)) = got else { panic!("{input:?}: {got:?}") };
                    assert_eq!((v.to_bits(), len), (bits(&row), text.len()), "{input:?}");
                }
                "unrepresentable" => {
                    assert_eq!(got, Some((StepNumber::Unrepresentable(text.as_bytes()), text.len())), "{input:?}");
                }
                _ => assert_eq!(got, None, "{input:?}"),
            }
        }
        // The grammar half is what the TS twin pins.
        let complete = step_numeric_literal_len(text.as_bytes()) == Some(text.len());
        let expect = row["kind"] != "refused" || row["grammar"].as_bool().unwrap();
        assert_eq!(complete, expect, "{text:?}");
        // `parse_step_real` (whole token, trimmed) is the same reader.
        let real = parse_step_real(format!(" \x0B{text}\x0C ").as_bytes());
        match row["kind"].as_str().unwrap() {
            "real" => assert_eq!(real.map(f64::to_bits), Some(bits(&row)), "{text:?}"),
            "integer" => assert_eq!(real, Some(row["value"].as_str().unwrap().parse::<i64>().unwrap() as f64), "{text:?}"),
            // An INTEGER beyond i64 is no `read_step_number` result, but a
            // whole-token real reader keeps reading it as an f64.
            "refused" if row["grammar"] == true => assert!(real.is_some(), "{text:?}"),
            _ => assert_eq!(real, None, "{text:?}"),
        }
    }
}

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

/// #7880: the bounded trailing-dot conversion and its general fallback must
/// match an independent decimal reader, including signed zero and rounding
/// beyond the exact-integer bound. Delimiters must not change consumed length.
#[test]
fn issue7880_integer_valued_reals_preserve_bits_across_conversion_boundary() {
    for magnitude in [
        "0", "1", "9", "12345678901234", "999999999999999",
        "1000000000000000", "9007199254740991", "9007199254740993",
        "000000000000001", "0000000000000000",
    ] {
        for sign in ["", "+", "-"] {
            for suffix in [".", ".0", ".E0", "E0"] {
                let text = format!("{sign}{magnitude}{suffix}");
                let expected = text.parse::<f64>().unwrap().to_bits();
                for tail in ["", ",2.", ")", " /* comment */"] {
                    let input = format!("{text}{tail}");
                    let Some((StepNumber::Real(value), len)) = read_step_number(input.as_bytes()) else {
                        panic!("expected REAL for {input:?}");
                    };
                    assert_eq!((value.to_bits(), len), (expected, text.len()), "{input:?}");
                }
            }
        }
    }
}

/// The single-pass reader values a literal in the grammar walk when one IEEE
/// operation is exact (mantissa <= 2^53, |power| <= 22) and asks
/// `fast_float2` otherwise; both must give the same bits as `fast_float2`
/// alone, and integers the same value as `str::parse::<i64>`, on every
/// literal shape: signs, leading zeros, bare dots, long mantissas around
/// 2^53, exponents around +-22, and the `i64` edge.
#[test]
fn single_pass_reader_matches_fast_float_and_i64_bit_for_bit() {
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    let mut next = |n: u64| {
        state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (state >> 33) % n
    };
    let mut cases: Vec<String> = [
        "9007199254740992.", "9007199254740993.", "-9007199254740993.", "9007199254740992.5",
        "1E22", "1E23", "1.E-22", "1.E-23", "123456789012345678.", "-0.", "0.E5", "-0.E-400",
        "1.7976931348623157E308", "1.E400", "4.9E-324", "1234567890123456789.", "12345678901234567890.",
        "0.000000000000000000001", "-1.5E+0010", "9223372036854775807", "-9223372036854775808",
        "9223372036854775808", "999999999999999999", "-999999999999999999", "+0007", "-0",
        "1E99999999999999999999", "1E-99999999999999999999",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    for _ in 0..200_000 {
        let mut text = String::new();
        text.push_str(["", "+", "-"][next(3) as usize]);
        let digits = |text: &mut String, count: u64, next: &mut dyn FnMut(u64) -> u64| {
            for _ in 0..count {
                text.push(char::from(b'0' + next(10) as u8));
            }
        };
        digits(&mut text, next(21), &mut next);
        if next(4) != 0 {
            text.push('.');
            digits(&mut text, next(21), &mut next);
        }
        if next(3) == 0 {
            text.push(['e', 'E'][next(2) as usize]);
            text.push_str(["", "+", "-"][next(3) as usize]);
            digits(&mut text, 1 + next(3), &mut next);
        }
        cases.push(text);
    }
    for text in &cases {
        let got = read_step_number(text.as_bytes());
        let has_digit = text.split(['e', 'E']).next().unwrap().bytes().any(|b| b.is_ascii_digit());
        let real = text.contains(['.', 'e', 'E']);
        match got {
            Some((StepNumber::Real(v), len)) => {
                assert!(real && len == text.len(), "{text}");
                let want: f64 = fast_float2::parse(text).unwrap();
                assert_eq!(v.to_bits(), want.to_bits(), "{text}");
            }
            Some((StepNumber::Unrepresentable(raw), _)) => {
                assert!(real && raw == text.as_bytes(), "{text}");
                assert!(!fast_float2::parse::<f64, _>(text).unwrap().is_finite(), "{text}");
            }
            Some((StepNumber::Integer(i), len)) => {
                assert!(!real && len == text.len(), "{text}");
                assert_eq!(Some(i), text.parse::<i64>().ok(), "{text}");
            }
            None => assert!(!has_digit || (!real && text.parse::<i64>().is_err()), "{text}"),
        }
    }
}

/// The work, not the value: a typical coordinate is valued in the grammar walk
/// that admitted it, and `fast_float2` is not asked to walk it again. Only a
/// literal outside the exact range (here 17 significant digits, and an
/// exponent past 10^22) still goes to `fast_float2`.
#[test]
fn a_typical_coordinate_is_valued_in_one_walk_without_fast_float() {
    let before = valuations();
    for text in ["1234.56789012345", "-0.5", "17.", ".25E-3", "1E5"] {
        assert!(matches!(read_step_number(text.as_bytes()), Some((StepNumber::Real(_), _))), "{text}");
    }
    let after_exact = valuations();
    assert_eq!(after_exact.0 - before.0, 5, "every exact-range REAL is valued in the walk");
    assert_eq!(after_exact.1 - before.1, 0, "fast_float2 is not called on the exact path");
    for text in ["0.12345678901234567", "1.5E40"] {
        assert!(matches!(read_step_number(text.as_bytes()), Some((StepNumber::Real(_), _))), "{text}");
    }
    let after_fallback = valuations();
    assert_eq!(after_fallback.0 - after_exact.0, 0);
    assert_eq!(after_fallback.1 - after_exact.1, 2, "outside the exact range fast_float2 still decides");
}
