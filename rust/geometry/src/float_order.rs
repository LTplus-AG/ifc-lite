// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A total order for `f64` sort keys (#7674).
//!
//! `a.partial_cmp(b).unwrap_or(Ordering::Equal)` is not a total order once a
//! NaN is in the slice: NaN is "equal" to everything, which is not
//! transitive. Since Rust 1.81, `sort_by` may panic on such a comparator, and
//! the wasm build is `panic = abort`, so one NaN from a file or a caller can
//! trap the shared instance. `scripts/check-float-sort-comparators.mjs` keeps
//! that spelling out of the tree.
//!
//! [`cmp_f64_nan_last`] is the drop-in replacement. For two numbers it returns
//! exactly what `partial_cmp` returned, including `-0.0 == +0.0`, so a sort
//! over finite (or infinite) keys keeps its old order byte for byte. That is
//! why it is used instead of `f64::total_cmp`, which orders `-0.0` before
//! `+0.0` and orders a NaN by its sign bit (x86 and wasm do not agree on the
//! sign of a NaN produced by arithmetic). Every NaN sorts after every number
//! and compares equal to every other NaN.

use std::cmp::Ordering;

/// Ascending order of `a` and `b`, with NaN after every number.
///
/// Use it as `xs.sort_by(|a, b| cmp_f64_nan_last(*a, *b))`. A descending sort
/// that swaps the arguments therefore puts NaN first.
#[inline]
pub fn cmp_f64_nan_last(a: f64, b: f64) -> Ordering {
    match a.partial_cmp(&b) {
        Some(order) => order,
        None => a.is_nan().cmp(&b.is_nan()),
    }
}

#[cfg(test)]
mod tests {
    use super::cmp_f64_nan_last;
    use std::cmp::Ordering;

    const VALUES: [f64; 9] =
        [f64::NEG_INFINITY, -1.5, -0.0, 0.0, 1e-300, 2.0, f64::INFINITY, f64::NAN, -f64::NAN];

    #[test]
    fn numbers_compare_exactly_like_partial_cmp() {
        for a in VALUES.iter().filter(|v| !v.is_nan()) {
            for b in VALUES.iter().filter(|v| !v.is_nan()) {
                assert_eq!(Some(cmp_f64_nan_last(*a, *b)), a.partial_cmp(b), "{a} vs {b}");
            }
        }
        assert_eq!(cmp_f64_nan_last(-0.0, 0.0), Ordering::Equal);
    }

    #[test]
    fn nan_of_either_sign_sorts_after_every_number() {
        for nan in [f64::NAN, -f64::NAN] {
            for x in VALUES.iter().filter(|v| !v.is_nan()) {
                assert_eq!(cmp_f64_nan_last(nan, *x), Ordering::Greater);
                assert_eq!(cmp_f64_nan_last(*x, nan), Ordering::Less);
            }
            assert_eq!(cmp_f64_nan_last(nan, f64::NAN), Ordering::Equal);
        }
    }

    /// The comparator is a total preorder, so the std sorts accept it: a
    /// slice past the 20-element insertion-sort cutoff with interleaved NaNs
    /// sorts without the "does not correctly implement a total order" panic.
    #[test]
    fn sorts_a_long_slice_with_interleaved_nans() {
        let mut xs: Vec<f64> =
            (0..200).map(|i| if i % 3 == 0 { f64::NAN } else { ((i * 7919) % 101) as f64 }).collect();
        xs.sort_by(|a, b| cmp_f64_nan_last(*a, *b));
        let first_nan = xs.iter().position(|x| x.is_nan()).expect("has NaN");
        assert!(xs[first_nan..].iter().all(|x| x.is_nan()));
        assert!(xs[..first_nan].windows(2).all(|w| w[0] <= w[1]));
        let mut ys = xs.clone();
        ys.sort_unstable_by(|a, b| cmp_f64_nan_last(*a, *b));
        assert_eq!(ys.iter().filter(|x| x.is_nan()).count(), 67);
    }
}
