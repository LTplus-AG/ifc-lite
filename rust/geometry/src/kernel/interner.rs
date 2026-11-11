// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Symbolic vertex interner — the arrangement's single source of vertex
//! identity.
//!
//! Two points that are EXACTLY coincident (`cmp_lex == Zero`) get the SAME `Vid`,
//! regardless of construction (LPI vs TPI vs Explicit) or insertion order — so
//! adjacent re-triangulated triangles conform along shared seams (design D3).
//! Identity is purely SYMBOLIC: no float coordinate is ever rounded to a bucket
//! (a float weld re-introduces cross-platform topology divergence — the
//! documented fatal risk). `Vid` is a STABLE append-only id (D4); dedup lookup
//! uses the internal `cmp_lex`-sorted index (`sorted`).

use super::predicates::cmp_lex;
use super::{fixed, interval, ImplicitPoint, Sign};
use std::cmp::Ordering;

/// Stable, append-only vertex identifier.
pub type Vid = u32;

#[derive(Default)]
pub struct Interner {
    points: Vec<ImplicitPoint>, // indexed by Vid
    sorted: Vec<Vid>,           // Vids in cmp_lex (lexicographic) order
    // Per-Vid cached I512 homogeneous lambda (computed once at intern). The hot
    // re-triangulation predicates evaluate exactly from this instead of
    // recomputing the LPI/TPI cross products every call. `None` = off-grid /
    // overflow ⇒ predicates fall back to the exact BigRational cascade.
    lambdas: Vec<Option<fixed::Lam>>,
    // Per-Vid cached f64-INTERVAL homogeneous lambda (also computed once). The hot
    // predicates run a directed-rounding f64 determinant from this FIRST and only
    // fall to the I512 `lambdas` on a zero-straddle — so the non-degenerate
    // majority never touches wasm-emulated wide integers. Always present (f64 is
    // always computable, even where the I512 lambda overflows to `None`).
    lambdas_iv: Vec<interval::IvLam>,
}

impl Interner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Intern a point: return the `Vid` of an exactly-coincident existing point,
    /// or assign and return a new stable `Vid`. O(log n) search + O(n) insert
    /// (n is small per the operand census).
    pub fn intern(&mut self, p: ImplicitPoint) -> Vid {
        // Compute the new point's cached lambda once; the binary-search compares
        // use it (fast exact) and fall back to the ImplicitPoint cmp_lex only on
        // off-grid/overflow.
        let new_lam = fixed::cached_lambda(&p);
        let new_lam_iv = interval::ilambda_cached(&p);
        let search = self.sorted.binary_search_by(|&vid| {
            // f64 interval compare from the cached lambdas first (pure f64, no
            // wide-int) → cached-I512 compare → ImplicitPoint cascade. Each tier
            // gives the SAME exact order; the interval just carries the
            // distinct-coordinate majority off the wasm-emulated I512 path.
            let s = interval::cmp_lex_from_lam_iv(&self.lambdas_iv[vid as usize], &new_lam_iv)
                // The interval cannot separate a point from itself. Re-interning
                // the SAME construction (bit-identical defining coordinates) is
                // the common case there (a third to over half of the interval
                // misses on CSG-heavy models): it is the same point, so `Zero`
                // is the exact answer without the I512 compare.
                .or_else(|| same_construction(&self.points[vid as usize], &p).then_some(Sign::Zero))
                .or_else(|| match (&self.lambdas[vid as usize], &new_lam) {
                    (Some(le), Some(ln)) => fixed::cmp_lex_from_lam(le, ln),
                    _ => None,
                })
                .unwrap_or_else(|| cmp_lex(&self.points[vid as usize], &p));
            match s {
                Sign::Negative => Ordering::Less,
                Sign::Positive => Ordering::Greater,
                Sign::Zero => Ordering::Equal,
            }
        });
        match search {
            Ok(idx) => self.sorted[idx],
            Err(idx) => {
                let vid = self.points.len() as Vid;
                self.points.push(p);
                self.lambdas.push(new_lam);
                self.lambdas_iv.push(new_lam_iv);
                self.sorted.insert(idx, vid);
                vid
            }
        }
    }

    pub fn get(&self, v: Vid) -> &ImplicitPoint {
        &self.points[v as usize]
    }

    /// The cached I512 lambda for a Vid (`None` if off-grid/overflow).
    #[inline]
    pub fn lam(&self, v: Vid) -> &Option<fixed::Lam> {
        &self.lambdas[v as usize]
    }

    /// The cached f64-interval lambda for a Vid (always present).
    #[inline]
    pub fn lam_iv(&self, v: Vid) -> &interval::IvLam {
        &self.lambdas_iv[v as usize]
    }

    // `is_empty` was deleted as dead code (D13 dead-code sweep: zero callers,
    // production or test) alongside `lex_order`; an interner is never
    // constructed and left empty in any live code path, so the clippy pairing
    // convention doesn't apply here.
    #[allow(clippy::len_without_is_empty)]
    pub fn len(&self) -> usize {
        self.points.len()
    }
}

/// True when `a` and `b` are the same construction with bit-identical
/// coordinates, hence the same exact point. Bitwise, so `-0.0` vs `0.0` or a
/// re-ordered construction answer false and fall through to exact arithmetic.
fn same_construction(a: &ImplicitPoint, b: &ImplicitPoint) -> bool {
    fn eq<const N: usize>(x: &[[f64; 3]; N], y: &[[f64; 3]; N]) -> bool {
        x.iter().flatten().zip(y.iter().flatten()).all(|(u, v)| u.to_bits() == v.to_bits())
    }
    match (a, b) {
        (ImplicitPoint::Explicit(x), ImplicitPoint::Explicit(y)) => eq(&[*x], &[*y]),
        (ImplicitPoint::Lpi(x), ImplicitPoint::Lpi(y)) => {
            eq(&[x.p, x.q, x.r, x.s, x.t], &[y.p, y.q, y.r, y.s, y.t])
        }
        (ImplicitPoint::Tpi(x), ImplicitPoint::Tpi(y)) => {
            eq(&[x.planes[0][0], x.planes[0][1], x.planes[0][2], x.planes[1][0], x.planes[1][1],
                 x.planes[1][2], x.planes[2][0], x.planes[2][1], x.planes[2][2]],
               &[y.planes[0][0], y.planes[0][1], y.planes[0][2], y.planes[1][0], y.planes[1][1],
                 y.planes[1][2], y.planes[2][0], y.planes[2][1], y.planes[2][2]])
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Lpi, Tpi};
    use super::*;

    fn lpi_at(x: f64, y: f64) -> ImplicitPoint {
        // vertical line at (x,y) ∩ z=0 plane -> (x,y,0)
        ImplicitPoint::Lpi(Lpi {
            p: [x, y, -1.],
            q: [x, y, 1.],
            r: [0., 0., 0.],
            s: [1., 0., 0.],
            t: [0., 1., 0.],
        })
    }
    fn tpi_at(x: f64, y: f64) -> ImplicitPoint {
        // planes x=x, y=y, z=0 -> (x,y,0)
        ImplicitPoint::Tpi(Tpi {
            planes: [
                [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]],
                [[x, 0., 0.], [x, 1., 0.], [x, 0., 1.]],
                [[0., y, 0.], [1., y, 0.], [0., y, 1.]],
            ],
        })
    }

    #[test]
    fn coincident_points_weld_to_one_vid() {
        let mut it = Interner::new();
        let a = it.intern(lpi_at(0.3, 0.4));
        let b = it.intern(tpi_at(0.3, 0.4)); // same point, different construction
        assert_eq!(a, b, "coincident LPI/TPI got different Vids");
        let c = it.intern(lpi_at(0.5, 0.4)); // distinct
        assert_ne!(a, c);
        assert_eq!(it.len(), 2);
    }

    #[test]
    fn same_construction_is_bitwise_and_exact() {
        let swapped = |p: ImplicitPoint| match p {
            ImplicitPoint::Lpi(l) => ImplicitPoint::Lpi(Lpi { p: l.q, q: l.p, ..l }),
            other => other,
        };
        assert!(same_construction(&lpi_at(0.3, 0.4), &lpi_at(0.3, 0.4)));
        assert!(same_construction(&tpi_at(0.3, 0.4), &tpi_at(0.3, 0.4)));
        assert!(same_construction(&ImplicitPoint::Explicit([1., 2., 3.]), &ImplicitPoint::Explicit([1., 2., 3.])));
        // Same point, different construction or signed zero: not claimed, exact path decides.
        assert!(!same_construction(&lpi_at(0.3, 0.4), &swapped(lpi_at(0.3, 0.4))));
        assert!(!same_construction(&lpi_at(0.3, 0.4), &tpi_at(0.3, 0.4)));
        assert!(!same_construction(&ImplicitPoint::Explicit([0., 2., 3.]), &ImplicitPoint::Explicit([-0., 2., 3.])));
        assert!(!same_construction(&lpi_at(0.3, 0.4), &lpi_at(0.3, 0.5)));
    }

    #[test]
    fn re_interning_weld_is_unchanged_by_the_identity_shortcut() {
        // Re-interned identical constructions take the shortcut; a reordered
        // construction of the same point still welds through exact arithmetic,
        // and a distinct point never does.
        let mut it = Interner::new();
        let pts = [lpi_at(0.3, 0.4), lpi_at(0.5, 0.4), tpi_at(0.7, 0.1), lpi_at(0.3, 0.4 + 1e-12)];
        let first: Vec<Vid> = pts.iter().map(|p| it.intern(p.clone())).collect();
        let again: Vec<Vid> = pts.iter().map(|p| it.intern(p.clone())).collect();
        assert_eq!(first, again);
        let reordered = match pts[0].clone() {
            ImplicitPoint::Lpi(l) => ImplicitPoint::Lpi(Lpi { p: l.q, q: l.p, ..l }),
            _ => unreachable!(),
        };
        assert_eq!(it.intern(reordered), first[0]);
        assert_ne!(first[0], first[3], "points 1e-12 apart must stay distinct");
        assert_eq!(it.len(), 4);
    }
}
