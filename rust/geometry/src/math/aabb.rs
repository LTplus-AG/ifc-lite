// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Axis-aligned boxes over `[f64; 3]`.

use super::v3::V3;

/// A closed axis-aligned box. [`Aabb3::EMPTY`] (`+INF`/`-INF`) is the identity
/// of [`Aabb3::extend`] and [`Aabb3::union`]; it is not well-formed, so nothing
/// publishes it by accident (see [`Aabb3::is_well_formed`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Aabb3 {
    pub min: V3,
    pub max: V3,
}

impl Aabb3 {
    /// No point yet: `min = +INF`, `max = -INF` on every axis.
    pub const EMPTY: Aabb3 = Aabb3 {
        min: [f64::INFINITY; 3],
        max: [f64::NEG_INFINITY; 3],
    };

    /// The box of `points` ([`Aabb3::EMPTY`] for none).
    #[inline]
    pub fn from_points(points: impl IntoIterator<Item = V3>) -> Aabb3 {
        let mut b = Aabb3::EMPTY;
        for p in points {
            b.extend(p);
        }
        b
    }

    /// The box of a flat `x, y, z, ...` f32 position buffer, widened exactly to
    /// f64. Only complete triplets count; a 1-2 float tail is ignored.
    #[inline]
    pub fn from_f32_positions(positions: &[f32]) -> Aabb3 {
        Aabb3::from_points(
            positions
                .chunks_exact(3)
                .map(|p| [p[0] as f64, p[1] as f64, p[2] as f64]),
        )
    }

    /// Grow to include `p`.
    ///
    /// Uses `f64::min`/`f64::max`, which return the non-NaN operand: a NaN
    /// coordinate is skipped rather than poisoning the box. That is the
    /// behaviour of every fold this replaces. It also means axes can diverge (one
    /// axis left at its sentinel while its neighbours hold real bounds), which is
    /// why publishing a box goes through [`Aabb3::is_well_formed`].
    #[inline]
    pub fn extend(&mut self, p: V3) {
        for k in 0..3 {
            self.min[k] = self.min[k].min(p[k]);
            self.max[k] = self.max[k].max(p[k]);
        }
    }

    /// The smallest box holding both (NaN skipped, as in [`Aabb3::extend`]).
    #[inline]
    pub fn union(&self, other: &Aabb3) -> Aabb3 {
        let mut u = *self;
        for k in 0..3 {
            u.min[k] = u.min[k].min(other.min[k]);
            u.max[k] = u.max[k].max(other.max[k]);
        }
        u
    }

    /// Closed overlap: boxes that merely touch overlap. An [`Aabb3::EMPTY`] box
    /// overlaps nothing.
    #[inline]
    pub fn overlaps(&self, other: &Aabb3) -> bool {
        (0..3).all(|k| self.min[k] <= other.max[k] && other.min[k] <= self.max[k])
    }

    /// Every axis finite and `min <= max`.
    ///
    /// All three axes are tested, not just one: because [`Aabb3::extend`] drops
    /// NaN, a position buffer carrying NaN on one axis and finite values on the
    /// others leaves that axis at its `INFINITY..NEG_INFINITY` sentinel while its
    /// neighbours hold real bounds. Testing only axis 0 would then publish
    /// `[x0, inf, z0, x1, -inf, z1]` as a measured box, which downstream
    /// differences turn into NaN. This also covers "no point was ever seen".
    #[inline]
    pub fn is_well_formed(&self) -> bool {
        (0..3).all(|k| {
            self.min[k].is_finite() && self.max[k].is_finite() && self.min[k] <= self.max[k]
        })
    }

    /// `[minx, miny, minz, maxx, maxy, maxz]`.
    #[inline]
    pub fn to_array6(&self) -> [f64; 6] {
        [
            self.min[0], self.min[1], self.min[2], self.max[0], self.max[1], self.max[2],
        ]
    }

    /// Inverse of [`Aabb3::to_array6`]; performs no validation.
    #[inline]
    pub fn from_array6(a: [f64; 6]) -> Aabb3 {
        Aabb3 { min: [a[0], a[1], a[2]], max: [a[3], a[4], a[5]] }
    }
}
