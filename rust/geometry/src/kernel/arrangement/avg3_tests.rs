// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for [`super::avg3`], the `2Sum`-cascade replacement for the naive
//! `(a + b + c) / 3.0` that `centroid` used to feed the exact predicates.
//! Split out per this module's `classify_tests.rs` precedent.
//!
//! **No external oracle is needed to trust the expected values.** In the three
//! `near_cancel_*` cases `a` and `c` are exact IEEE-754 negatives of each
//! other (negation is always exact for a finite float), so the true
//! real-number sum of the triple is exactly `b`, and the correctly-rounded
//! average is exactly `b / 3.0` — a single IEEE division, which the spec
//! requires to be correctly rounded. A reviewer can check that by inspection.
//!
//! `large_magnitude_random` is not of that symmetric shape. Its expected value
//! was computed offline as the exact rational sum divided by three, rounded
//! once to `f64`. That is reproducible outside this repo but is not re-derived
//! at test time, and is flagged here rather than presented as self-evident.
//!
//! The second test asserts the naive formula gives a DIFFERENT answer on these
//! same inputs. That is what makes this suite falsify a revert: a regression
//! test both implementations pass would be worthless.

use super::avg3;

fn naive(a: f64, b: f64, c: f64) -> f64 {
    (a + b + c) / 3.0
}

struct Case {
    name: &'static str,
    a: f64,
    b: f64,
    c: f64,
    expected: f64,
}

/// Near-cancelling and large-magnitude triples, where the naive summation
/// order loses `b` — entirely, in the first case — to intermediate rounding
/// before the division happens. A sub-triangle at a shared hub has this shape.
fn adversarial_cases() -> Vec<Case> {
    vec![
        Case {
            // Real sum is exactly 1.0, so the average is exactly 1.0/3.0.
            // Naive returns 0.0: `1e16 + 1.0` rounds back to `1e16`.
            name: "near_cancel_1e16",
            a: 1e16,
            b: 1.0,
            c: -1e16,
            expected: 1.0 / 3.0,
        },
        Case {
            name: "near_cancel_1e8",
            a: 1e8,
            b: 1e-8,
            c: -1e8,
            expected: 1e-8 / 3.0,
        },
        Case {
            // The magnitude this routine is actually exercised at.
            name: "near_cancel_1e6",
            a: 1_234_567.0,
            b: 1e-6,
            c: -1_234_567.0,
            expected: 1e-6 / 3.0,
        },
        Case {
            // No exact-negative structure; see the module doc on provenance.
            name: "large_magnitude_random",
            a: -1_083_807.712_143_582_5,
            b: -1_871_599.024_383_849,
            c: 2_955_406.736_158_338,
            expected: -0.000_123_031_204_566_359_52,
        },
        Case {
            // The case that motivates the whole change, and the least
            // contrived: site-scale coordinates (~1e7, ordinary for a
            // georeferenced model) forming a near-cancelling hub triple of the
            // shape CSG sub-triangulation produces at a shared edge. Naive and
            // exact centroids differ by ~3.1e-10 — ample room for a plane
            // through the other operand to fall between them, which is exactly
            // how a rounded centroid flips a classification.
            name: "site_scale_hub_near_cancel",
            a: 9_962_210.139_537_863,
            b: -0.011_965_918_354_684_524,
            c: -9_962_210.139_537_925,
            expected: -0.003_988_659_940_658_15,
        },
    ]
}

#[test]
fn avg3_matches_the_correctly_rounded_average_on_adversarial_triples() {
    for case in adversarial_cases() {
        let got = avg3(case.a, case.b, case.c);
        assert_eq!(
            got, case.expected,
            "avg3 [{}]: got {got:?}, expected {:?}",
            case.name, case.expected
        );
    }
}

/// The point of `avg3`: the naive form is measurably wrong on these same
/// inputs. If this ever starts failing, the cases have stopped being
/// adversarial and need replacing — not deleting.
#[test]
fn the_naive_average_is_wrong_on_the_same_triples() {
    for case in adversarial_cases() {
        let n = naive(case.a, case.b, case.c);
        assert_ne!(
            n, case.expected,
            "naive() matched the correct average for [{}]; this case no longer \
             exercises anything and must be replaced",
            case.name
        );
    }
}

/// There is exactly one correctly-rounded `f64` for a given exact sum, however
/// that sum was accumulated, so `avg3` must not depend on argument order. A
/// reassociation that special-cased one ordering would pass both tests above
/// and fail this one.
#[test]
fn avg3_is_invariant_under_argument_permutation() {
    for case in adversarial_cases() {
        let (a, b, c) = (case.a, case.b, case.c);
        for (x, y, z) in [
            (a, b, c),
            (a, c, b),
            (b, a, c),
            (b, c, a),
            (c, a, b),
            (c, b, a),
        ] {
            assert_eq!(
                avg3(x, y, z),
                case.expected,
                "avg3 [{}] diverged under permutation ({x}, {y}, {z})",
                case.name
            );
        }
    }
}

/// Values with no rounding ambiguity anywhere in the cascade, pinning that no
/// incidental tie-breaking is baked in. The naive form agrees here too — that
/// is expected, and is why these are not the cases doing the real work.
#[test]
fn avg3_handles_exact_ties_and_identical_inputs() {
    assert_eq!(avg3(5.0, 5.0, 5.0), 5.0);
    assert_eq!(avg3(1.0, 1.0, 4.0), 2.0);
    assert_eq!(avg3(-2.5, -2.5, -2.5), -2.5);
    assert_eq!(avg3(0.0, 0.0, 0.0), 0.0);
}
