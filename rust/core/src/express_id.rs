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
//! [`parse_express_id`] is called from both sides of that contract: the
//! definition scanner ([`crate::parser::scanner::EntityScanner`]) and every
//! `#<digits>` reference reader in [`crate::fast_parse`] and
//! [`crate::decoder`]. A second, independently-written copy of this
//! accumulation is exactly the drift #3395 was careful to avoid, so a new
//! caller must reuse this function rather than writing its own loop.
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
pub(crate) fn parse_express_id(digits: &[u8]) -> Option<u32> {
    debug_assert!(
        !digits.is_empty() && digits.iter().all(u8::is_ascii_digit),
        "parse_express_id expects a validated, non-empty digit run"
    );
    let mut result: u32 = 0;
    if digits.len() <= 9 {
        for &b in digits {
            result = result * 10 + (b - b'0') as u32;
        }
        return Some(result);
    }
    for &b in digits {
        result = result.checked_mul(10)?.checked_add((b - b'0') as u32)?;
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
}
