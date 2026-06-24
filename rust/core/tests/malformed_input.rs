// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression coverage for hostile / malformed entity input. The contract is:
//! the parser rejects bad records with an `Err`, and never panics, overflows,
//! or hangs. The `parse_entity` fuzz target in `fuzz/` exercises the same
//! surface continuously; these cases pin specific behaviors in normal CI.

use ifc_lite_core::parse_entity;

#[test]
fn truncated_missing_close_paren_is_err() {
    assert!(parse_entity(b"#1=IFCWALL('g',$,$".as_slice()).is_err());
}

#[test]
fn truncated_missing_semicolon_is_err() {
    // parse_entity requires the closing `)` followed by `;`.
    assert!(parse_entity(b"#1=IFCWALL('g',$,$)".as_slice()).is_err());
}

#[test]
fn non_numeric_id_is_err() {
    assert!(parse_entity(b"#ABC=IFCWALL('g',$,$);".as_slice()).is_err());
}

#[test]
fn id_overflow_is_err_not_wrap_or_panic() {
    // 20 nines overflows u32; lexical_core must reject it rather than wrap.
    assert!(parse_entity(b"#99999999999999999999=IFCWALL('g',$);".as_slice()).is_err());
}

#[test]
fn unterminated_string_is_err() {
    assert!(parse_entity(b"#1=IFCWALL('unterminated,$,$);".as_slice()).is_err());
}

#[test]
fn leading_bom_is_err() {
    let mut input = vec![0xEF, 0xBB, 0xBF];
    input.extend_from_slice(b"#1=IFCWALL('g',$);");
    assert!(parse_entity(input.as_slice()).is_err());
}

#[test]
fn empty_and_tiny_inputs_are_err() {
    for input in [b"".as_slice(), b"#".as_slice(), b"#1".as_slice(), b"#1=".as_slice()] {
        assert!(parse_entity(input).is_err(), "expected Err for {input:?}");
    }
}

#[test]
fn embedded_null_byte_in_string_does_not_panic() {
    // A NUL inside a string body is valid STEP content; must not panic.
    let _ = parse_entity(b"#1=IFCWALL('a\0b',$,$);".as_slice());
}

#[test]
fn float_overflow_does_not_panic() {
    // 1e400 is out of f64 range; the parser must not panic on it.
    let _ = parse_entity(b"#1=IFCCARTESIANPOINT((1e400,2.,3.));".as_slice());
}

#[test]
fn deeply_nested_lists_do_not_overflow_the_stack() {
    // The parser caps nesting depth; a very deep input must return, not crash.
    let mut input = b"#1=IFCWALL(".to_vec();
    input.extend(std::iter::repeat_n(b'(', 2000));
    input.extend_from_slice(b");");
    let _ = parse_entity(input.as_slice());
}

/// Deterministic pseudo-random byte sweep: throw many structured-ish inputs at
/// `parse_entity` and assert none panic. A fixed LCG keeps it reproducible in
/// CI; the `fuzz/` target does the unbounded coverage-guided version.
#[test]
fn random_byte_sweep_never_panics() {
    let alphabet = b"#=()',$;.0123456789IFCWAL \n\t\\X2X0";
    let mut state: u64 = 0x9E3779B97F4A7C15;
    let mut next = || {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (state >> 33) as usize
    };

    for _ in 0..20_000 {
        let len = next() % 64;
        let mut buf = Vec::with_capacity(len);
        for _ in 0..len {
            buf.push(alphabet[next() % alphabet.len()]);
        }
        // The only assertion is that this call returns rather than panicking.
        let _ = parse_entity(buf.as_slice());
    }
}
