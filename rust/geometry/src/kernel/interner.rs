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
//! documented fatal risk). `Vid` is a STABLE append-only id (D4); the canonical
//! processing order is the position in the `cmp_lex`-sorted index (`lex_order`).

use super::predicates::cmp_lex;
use super::{fixed, ImplicitPoint, Sign};
use std::cmp::Ordering;

/// Stable, append-only vertex identifier.
pub type Vid = u32;

#[derive(Default)]
pub struct Interner {
    points: Vec<ImplicitPoint>, // indexed by Vid
    sorted: Vec<Vid>,           // Vids in cmp_lex (lexicographic) order
    // Per-Vid cached I1024 homogeneous lambda (computed once at intern). The hot
    // re-triangulation predicates evaluate exactly from this instead of
    // recomputing the LPI/TPI cross products every call. `None` = off-grid /
    // overflow ⇒ predicates fall back to the exact BigRational cascade.
    lambdas: Vec<Option<fixed::Lam>>,
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
        let new_lam = fixed::lambda1024(&p);
        let search = self.sorted.binary_search_by(|&vid| {
            let s = match (&self.lambdas[vid as usize], &new_lam) {
                (Some(le), Some(ln)) => fixed::cmp_lex_from_lam(le, ln),
                _ => None,
            }
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
                self.sorted.insert(idx, vid);
                vid
            }
        }
    }

    pub fn get(&self, v: Vid) -> &ImplicitPoint {
        &self.points[v as usize]
    }

    /// The cached I1024 lambda for a Vid (`None` if off-grid/overflow).
    #[inline]
    pub fn lam(&self, v: Vid) -> &Option<fixed::Lam> {
        &self.lambdas[v as usize]
    }

    pub fn len(&self) -> usize {
        self.points.len()
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    /// The `Vid`s in canonical (lexicographic) order — the deterministic
    /// processing order for the re-triangulation.
    pub fn lex_order(&self) -> &[Vid] {
        &self.sorted
    }
}

#[cfg(test)]
mod tests {
    use super::super::rational::point_of;
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
    fn interning_is_order_independent_canonically() {
        let inputs = || {
            vec![
                lpi_at(0.5, 0.1),
                tpi_at(0.2, 0.7),
                ImplicitPoint::Explicit([0.9, 0.9, 0.0]),
                lpi_at(0.2, 0.7), // coincides with tpi_at(0.2,0.7)
            ]
        };
        let canonical = |order: &[usize]| {
            let mut it = Interner::new();
            let ps = inputs();
            for &i in order {
                it.intern(ps[i].clone());
            }
            it.lex_order().iter().map(|&v| point_of(it.get(v))).collect::<Vec<_>>()
        };
        let forward = canonical(&[0, 1, 2, 3]);
        let backward = canonical(&[3, 2, 1, 0]);
        assert_eq!(forward, backward, "canonical lex order is insertion-order dependent");
        assert_eq!(forward.len(), 3, "one coincidence should leave 3 distinct points");
    }
}
