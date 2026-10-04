// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Public predicate dispatch over `ImplicitPoint` configurations.
//!
//! Implements every explicit/implicit `orient3d`/`orient2d` configuration the
//! arrangement pipeline produces, each first through the fast interval and
//! fixed-width tiers and escalating to the exact (BigRational) tier on a
//! straddling filter — every fast tier verified `≡` the exact tier here.

use super::{fixed, interval, rational};
use super::{DropAxis, ImplicitPoint, Sign};

/// Exact explicit-coordinate entry point. Callers which already hold explicit
/// coordinates need not construct and dispatch four `ImplicitPoint` values
/// (#6537). Keep the same adaptive predicate and sign conversion as the mixed
/// dispatcher; this changes no arithmetic or degeneracy policy.
#[inline]
pub(crate) fn orient3d_explicit(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> Sign {
    Sign::from_f64(geometry_predicates::orient3d(a, b, c, d))
}

/// Exact `orient3d` over a mix of explicit + implicit points.
///
/// Cascade: explicit args go through the Shewchuk adaptive predicate (its own
/// semi-static→exact ladder). Indirect args try the interval tier first and
/// escalate to the exact (BigRational) tier only on a straddle. Every tier
/// returns the SAME sign — verified against the oracle in tests.
pub fn orient3d(a: &ImplicitPoint, b: &ImplicitPoint, c: &ImplicitPoint, d: &ImplicitPoint) -> Sign {
    use ImplicitPoint::{Explicit, Lpi, Tpi};
    match (a, b, c, d) {
        (Explicit(a), Explicit(b), Explicit(c), Explicit(d)) => {
            orient3d_explicit(*a, *b, *c, *d)
        }
        (Lpi(l), Explicit(b), Explicit(c), Explicit(d)) => interval::lpi_orient3d(l, *b, *c, *d)
            .or_else(|| {
                crate::kernel::budget::note_escalation();
                fixed::indirect_orient3d(a, *b, *c, *d)
            })
            .unwrap_or_else(|| rational::lpi_orient3d(l, *b, *c, *d)),
        (Tpi(t), Explicit(b), Explicit(c), Explicit(d)) => interval::tpi_orient3d(t, *b, *c, *d)
            .or_else(|| {
                crate::kernel::budget::note_escalation();
                fixed::indirect_orient3d(a, *b, *c, *d)
            })
            .unwrap_or_else(|| rational::tpi_orient3d(t, *b, *c, *d)),
        // By-construction unreachable: kernel callers only ever build the configurations above.
        _ => unimplemented!(
            "kernel::orient3d: implicit-point configuration never produced by the arrangement pipeline"
        ),
    }
}

/// Exact `orient2d(a, b, c)` projected on the two axes remaining after dropping
/// `axis` (the in-plane predicate for re-triangulation). Same cascade as
/// `orient3d`; the indirect 1-implicit case shares the `sign(d)` flip.
pub fn orient2d(a: &ImplicitPoint, b: &ImplicitPoint, c: &ImplicitPoint, axis: DropAxis) -> Sign {
    use ImplicitPoint::{Explicit, Lpi, Tpi};
    let (i, j) = match axis {
        DropAxis::X => (1, 2),
        DropAxis::Y => (0, 2),
        DropAxis::Z => (0, 1),
    };
    match (a, b, c) {
        (Explicit(a), Explicit(b), Explicit(c)) => {
            Sign::from_f64(geometry_predicates::orient2d([a[i], a[j]], [b[i], b[j]], [c[i], c[j]]))
        }
        (Lpi(l), Explicit(b), Explicit(c)) => interval::lpi_orient2d(l, *b, *c, axis)
            .or_else(|| {
                crate::kernel::budget::note_escalation();
                fixed::indirect_orient2d(a, *b, *c, axis)
            })
            .unwrap_or_else(|| rational::lpi_orient2d(l, *b, *c, axis)),
        (Tpi(t), Explicit(b), Explicit(c)) => interval::tpi_orient2d(t, *b, *c, axis)
            .or_else(|| {
                crate::kernel::budget::note_escalation();
                fixed::indirect_orient2d(a, *b, *c, axis)
            })
            .unwrap_or_else(|| rational::tpi_orient2d(t, *b, *c, axis)),
        // By-construction unreachable: kernel callers only ever build the configurations above.
        _ => unimplemented!(
            "kernel::orient2d: implicit-point configuration never produced by the arrangement pipeline"
        ),
    }
}

/// orient2d with two implicit points (a,b) + one explicit (c) — cascade.
pub fn orient2d_2i(a: &ImplicitPoint, b: &ImplicitPoint, c: [f64; 3], axis: DropAxis) -> Sign {
    // cascade: interval filter → fixed-width exact (fast) → BigRational (off-grid / overflow)
    interval::orient2d_2i(a, b, c, axis)
        .or_else(|| {
            crate::kernel::budget::note_escalation();
            fixed::orient2d_2i(a, b, c, axis)
        })
        .unwrap_or_else(|| rational::orient2d_2i(a, b, c, axis))
}

/// orient2d with three implicit points (a,b,c) — cascade.
pub fn orient2d_3i(a: &ImplicitPoint, b: &ImplicitPoint, c: &ImplicitPoint, axis: DropAxis) -> Sign {
    interval::orient2d_3i(a, b, c, axis)
        .or_else(|| {
            crate::kernel::budget::note_escalation();
            fixed::orient2d_3i(a, b, c, axis)
        })
        .unwrap_or_else(|| rational::orient2d_3i(a, b, c, axis))
}

/// Exact lexicographic total order on points — the interner's comparison (cascade).
pub fn cmp_lex(a: &ImplicitPoint, b: &ImplicitPoint) -> Sign {
    interval::cmp_lex(a, b)
        .or_else(|| {
            crate::kernel::budget::note_escalation();
            fixed::cmp_lex(a, b)
        })
        .unwrap_or_else(|| rational::cmp_lex(a, b))
}

#[inline]
fn explicit_coord(p: &ImplicitPoint) -> [f64; 3] {
    match p {
        ImplicitPoint::Explicit(c) => *c,
        _ => unreachable!("explicit_coord on an implicit point"),
    }
}

/// `orient2d` over ANY mix of explicit/implicit points in ANY argument position
/// (the predicate the re-triangulation's point location needs). `orient2d` is
/// antisymmetric, so we canonicalise the args to implicit-first (stable, to keep
/// it a pure function), dispatch to the 0I/1I/2I/3I config, and flip the result
/// once per transposition (the permutation parity).
pub fn orient2d_any(a: &ImplicitPoint, b: &ImplicitPoint, c: &ImplicitPoint, axis: DropAxis) -> Sign {
    let pts = [a, b, c];
    let key = |p: &ImplicitPoint| u8::from(matches!(p, ImplicitPoint::Explicit(_))); // implicit=0
    let keys = [key(a), key(b), key(c)];
    let mut perm = [0usize, 1, 2];
    perm.sort_by_key(|&i| keys[i]); // stable → implicit first, original order kept
    let inversions = u8::from(perm[0] > perm[1]) + u8::from(perm[0] > perm[2]) + u8::from(perm[1] > perm[2]);
    let rp = [pts[perm[0]], pts[perm[1]], pts[perm[2]]];
    let n_implicit = 3 - (keys[0] + keys[1] + keys[2]) as usize;
    let canonical = match n_implicit {
        // (E,E,E) and (I,E,E) are handled by the position-specific dispatch.
        0 | 1 => orient2d(rp[0], rp[1], rp[2], axis),
        2 => orient2d_2i(rp[0], rp[1], explicit_coord(rp[2]), axis),
        _ => orient2d_3i(rp[0], rp[1], rp[2], axis),
    };
    if inversions % 2 == 1 {
        canonical.flip()
    } else {
        canonical
    }
}

#[cfg(test)]
#[path = "predicates_tests.rs"]
mod tests;
