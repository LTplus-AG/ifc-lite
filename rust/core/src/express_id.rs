// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The single place in this crate that decides whether a digit run read
//! from a raw IFC byte slice fits an express id.
//!
//! ISO 10303-21 writes an instance name (`#<digits>`) with no upper bound, so
//! a file MAY legally contain `#4294967297`. Nothing downstream of this crate
//! can hold one: every store that keys on an express id narrows it to `u32`.
//! Accumulating with `wrapping_mul`/`wrapping_add` does not error on an
//! oversized run, it silently maps it onto a real low-numbered id — a value
//! collision, not a missing value (issue #3395, split for the reference
//! readers in #3421).
//!
//! [`parse_express_id`] and the internal prefix reader serve both sides: the
//! definition scanner ([`crate::parser::scanner::EntityScanner`]) and every
//! `#<digits>` reference reader in [`crate::fast_parse`] and
//! [`crate::decoder`], and — now that it is `pub` — the REFERENCE readers in
//! `ifc-lite-geometry`, `ifc-lite-export` and `ifc-lite-processing` that read
//! raw STEP bytes outside this crate. A second, independently-written copy of
//! this accumulation is exactly the drift #3395 was careful to avoid. New
//! callers reuse these canonical readers, which share the digit arithmetic.
//!
//! The bound is inclusive: `u32::MAX` is a legitimate express id and parses
//! successfully. Refusal (`None`) is the only outcome for anything past it —
//! there is no saturating variant here. A caller that saturated an oversized
//! reference to `u32::MAX` would risk binding it to a real entity that
//! legitimately holds that id, which is the same collision this function
//! exists to prevent, just relocated to the sentinel value. Contrast
//! [`crate::fast_parse::parse_indices_direct`], which deliberately
//! *saturates* an out-of-range vertex index to `u32::MAX`: that value is a
//! sentinel a downstream bounds check drops, not a key another value could
//! collide with, so saturation is safe there and is not safe here.

const UNCHECKED_DIGITS: usize = 9;

#[inline]
fn append_digit(value: u32, byte: u8) -> u32 {
    value * 10 + (byte - b'0') as u32
}

#[inline]
fn append_digit_checked(value: u32, byte: u8) -> Option<u32> {
    value.checked_mul(10)?.checked_add((byte - b'0') as u32)
}

/// Read the leading ASCII digit run, returning its byte length and express id.
/// An empty or overflowing run yields None, but overflow never stops scanning:
/// callers still need the exact prefix end to validate the declaration (#3987).
/// First-nine-digit arithmetic is unchecked because it cannot exceed 999999999.
#[inline]
pub(crate) fn parse_express_id_prefix(input: &[u8]) -> (usize, Option<u32>) {
    let mut end = 0;
    let mut result = 0u32;
    for &byte in input.iter().take(UNCHECKED_DIGITS) {
        if !byte.is_ascii_digit() { return (end, (end != 0).then_some(result)); }
        result = append_digit(result, byte);
        end += 1;
    }
    if end == 0 { return (0, None); }
    let mut value = Some(result);
    for &byte in &input[end..] {
        if !byte.is_ascii_digit() { break; }
        value = value.and_then(|value| append_digit_checked(value, byte));
        end += 1;
    }
    (end, value)
}

/// Parse `digits` — an already-validated, non-empty run of ASCII digit bytes
/// — into a `u32` express id, or `None` if the value does not fit.
///
/// Two loops rather than one: a run of at most 9 digits is at most
/// 999_999_999 and cannot overflow `u32`, so the common case (every real
/// exporter's ids) keeps the unchecked instruction sequence. Only a 10+
/// digit run — which no real exporter emits — pays for `checked_mul` /
/// `checked_add`.
///
/// Callers are expected to have already located the digit run (e.g. by
/// scanning forward while `is_ascii_digit()` holds); this function does not
/// search for one and returns `Some(0)` for an all-zero run rather than
/// treating it as absent — callers that treat id `0` as "no reference" must
/// check that themselves, the same way they did before this helper existed.
#[inline]
pub fn parse_express_id(digits: &[u8]) -> Option<u32> {
    debug_assert!(
        !digits.is_empty() && digits.iter().all(u8::is_ascii_digit),
        "parse_express_id expects a validated, non-empty digit run"
    );
    let mut result: u32 = 0;
    if digits.len() <= UNCHECKED_DIGITS {
        for &b in digits {
            result = append_digit(result, b);
        }
        return Some(result);
    }
    for &b in digits {
        result = append_digit_checked(result, b)?;
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_runs_parse_without_overflow_checks() {
        assert_eq!(parse_express_id(b"1"), Some(1));
        assert_eq!(parse_express_id(b"999999999"), Some(999_999_999));
    }

    #[test]
    fn max_u32_is_inclusive() {
        assert_eq!(parse_express_id(b"4294967295"), Some(u32::MAX));
    }

    #[test]
    fn one_past_max_is_refused_not_wrapped() {
        // 4294967296 = 2^32: the first value that does not fit u32. A
        // wrapping accumulator would yield 0; this must yield None.
        assert_eq!(parse_express_id(b"4294967296"), None);
    }

    #[test]
    fn the_defect_value_is_refused_not_aliased_to_a_real_id() {
        // 4294967297 % 2^32 == 1: a wrapping accumulator binds this to a
        // real #1, which is the actual defect (#3421), not merely an
        // overflow that errors.
        assert_eq!(parse_express_id(b"4294967297"), None);
    }

    /// #3987: independent decimal-parser oracle covers leading zeroes and long
    /// overflow prefixes, including bytes that must remain for the scanner.
    #[test]
    fn express_prefix_matches_checked_decimal_oracle_3987() {
        let runs = ["0", "1", "999999999", "1000000000", "4294967295",
            "4294967296", "4294967297", "999999999999999999999999999999999"];
        for zeros in [0, 1, 9, 10, 64, 1024] {
            for run in runs {
                let digits = format!("{}{run}", "0".repeat(zeros));
                let expected = digits.parse::<u32>().ok();
                assert_eq!(parse_express_id(digits.as_bytes()), expected);
                for suffix in [b"".as_slice(), b"=IFCWALL($);", b"/* ; */ =", b"x", b"\xff"] {
                    let source = [digits.as_bytes(), suffix].concat();
                    assert_eq!(parse_express_id_prefix(&source), (digits.len(), expected));
                }
            }
        }
        for source in [b"".as_slice(), b"=", b"-1", b"+1", b" ", b"\xff"] {
            assert_eq!(parse_express_id_prefix(source), (0, None));
        }
        for value in [2u32, 19, 100, 123456789, u32::MAX - 1] {
            let source = format!("{value};trailing");
            assert_eq!(parse_express_id_prefix(source.as_bytes()),
                (value.to_string().len(), Some(value)));
        }
    }
}
