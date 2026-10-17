// SPDX-License-Identifier: MPL-2.0
//! Canonical number-to-text for property values, the inverse of the float
//! parsing core already owns.

/// Format an f64 without noisy trailing zeros (`1.0` -> `1`, `1.50` -> `1.5`),
/// and otherwise with the shortest digits that parse back to the same value
/// (what JS `String(n)` shows for the same value in the ranges that matter).
///
/// The digits must round-trip: no fixed decimal count, so a small nonzero never
/// reads as `0`. Integral values below 1e15 print as integers.
pub fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

#[cfg(test)]
mod tests {
    use super::fmt_num;

    #[test]
    fn integral_values_drop_the_fraction_and_others_round_trip() {
        assert_eq!(fmt_num(200.0), "200");
        assert_eq!(fmt_num(-0.0), "0");
        assert_eq!(fmt_num(1.5), "1.5");
        for v in [2.5e-7, 1234.56789012, 1e15, 0.1 + 0.2] {
            assert_eq!(fmt_num(v).parse::<f64>().unwrap(), v);
        }
        assert_eq!(fmt_num(1e15), "1000000000000000");
    }
}
