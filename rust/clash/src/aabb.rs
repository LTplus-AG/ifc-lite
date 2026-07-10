// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Axis-aligned bounding boxes and the cheap separation/overlap helpers the
//! clash engine relies on.
//!
//! The box math lives in the Plato-generated `generated::plato::Box3` (from
//! `tools/plato/clash_math.plato`); the [`Aabb`] type below keeps the crate's
//! `[f64; 3]` corner shape and the buffer-walking [`Aabb::from_positions`], and
//! its remaining methods/free functions are byte-compatible adapters over
//! `Box3`.

use crate::generated::plato::{Box3, Vec3 as PlatoVec3};
use crate::vec3::Vec3;

/// An axis-aligned bounding box with explicit `min`/`max` corners.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Aabb {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

/// Pack an [`Aabb`] into the generated `Box3`.
#[inline]
fn to_box3(a: &Aabb) -> Box3 {
    Box3::new(
        PlatoVec3::new(a.min[0], a.min[1], a.min[2]),
        PlatoVec3::new(a.max[0], a.max[1], a.max[2]),
    )
}

/// Unpack a generated `Box3` back into an [`Aabb`].
#[inline]
fn from_box3(b: Box3) -> Aabb {
    Aabb::new(
        [b.Min.X, b.Min.Y, b.Min.Z],
        [b.Max.X, b.Max.Y, b.Max.Z],
    )
}

impl Aabb {
    #[inline]
    pub fn new(min: [f64; 3], max: [f64; 3]) -> Self {
        Self { min, max }
    }

    /// Axis-aligned bounds of a packed `[x, y, z, ...]` position buffer.
    ///
    /// Mirrors `fromPositions`; the optional transform from the TS source is
    /// dropped because the native API ingests world-space geometry directly.
    /// Stays a hand-written buffer walk (the generated math is per-box, not
    /// over a flat vertex stream).
    pub fn from_positions(positions: &[f64]) -> Aabb {
        if positions.len() < 3 {
            return Aabb::new([0.0, 0.0, 0.0], [0.0, 0.0, 0.0]);
        }
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        let mut i = 0;
        while i + 2 < positions.len() {
            for axis in 0..3 {
                let v = positions[i + axis];
                if v < min[axis] {
                    min[axis] = v;
                }
                if v > max[axis] {
                    max[axis] = v;
                }
            }
            i += 3;
        }
        Aabb::new(min, max)
    }

    /// Expand bounds by `m` on every side. Delegates to `Box3::Inflate`.
    #[inline]
    pub fn inflate(&self, m: f64) -> Aabb {
        from_box3(to_box3(self).Inflate(m))
    }

    /// Center point of the box. Delegates to `Box3::Center`.
    #[inline]
    pub fn center(&self) -> Vec3 {
        let c = to_box3(self).Center();
        [c.X, c.Y, c.Z]
    }

    /// True when the two boxes overlap (touching counts). Delegates to
    /// `Box3::Intersects`.
    #[inline]
    pub fn intersects(&self, b: &Aabb) -> bool {
        to_box3(self).Intersects(to_box3(b))
    }
}

/// Signed gap between two boxes: `>0` is the Euclidean separation, `<0` is the
/// penetration depth (negative of the minimum-axis overlap). Delegates to
/// `Box3::SignedGap`.
pub fn signed_gap(a: &Aabb, b: &Aabb) -> f64 {
    to_box3(a).SignedGap(to_box3(b))
}

/// The intersection box of two overlapping bounds (clamped to be non-inverted).
/// Delegates to `Box3::OverlapBounds`.
pub fn overlap_bounds(a: &Aabb, b: &Aabb) -> Aabb {
    from_box3(to_box3(a).OverlapBounds(to_box3(b)))
}

/// Bounds enclosing two points. Delegates to `Vec3::BoundsOfPoints`.
pub fn bounds_of_points(a: Vec3, b: Vec3) -> Aabb {
    from_box3(
        PlatoVec3::new(a[0], a[1], a[2]).BoundsOfPoints(PlatoVec3::new(b[0], b[1], b[2])),
    )
}

/// True when `outer` fully contains `inner` (face-sharing counts as contained).
/// Cheap precondition for the enclosed-solid test in the narrow phase. Delegates
/// to `Box3::Contains`, which mirrors the TS `aabbContains` exactly (same
/// `<=`/`>=`, axis order 0,1,2).
#[inline]
pub fn aabb_contains(outer: &Aabb, inner: &Aabb) -> bool {
    to_box3(outer).Contains(to_box3(inner))
}
