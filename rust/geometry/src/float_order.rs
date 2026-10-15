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
#[path = "float_order_tests.rs"]
mod tests;
