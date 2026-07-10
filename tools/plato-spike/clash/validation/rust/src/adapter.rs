//! Reference-shaped API ([f64; 3] vectors, min/max Aabb struct) implemented
//! ONLY in terms of the generated `plato` module. No math is done here: every
//! function converts the argument shapes and delegates to plato.

use crate::plato;

/// A 3-component vector stored as `[x, y, z]` (reference shape).
pub type Vec3 = [f64; 3];

/// An axis-aligned bounding box with explicit `min`/`max` corners (reference shape).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Aabb {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

#[inline]
fn pv(v: Vec3) -> plato::Vec3 {
    plato::Vec3::new(v[0], v[1], v[2])
}

#[inline]
fn vp(v: plato::Vec3) -> Vec3 {
    [v.X, v.Y, v.Z]
}

#[inline]
fn pb(b: &Aabb) -> plato::Box3 {
    plato::Box3::new(pv(b.min), pv(b.max))
}

#[inline]
fn bp(b: plato::Box3) -> Aabb {
    Aabb {
        min: vp(b.Min),
        max: vp(b.Max),
    }
}

// ---- vec3 surface -----------------------------------------------------------

#[inline]
pub fn sub(a: Vec3, b: Vec3) -> Vec3 {
    vp(pv(a).Sub(pv(b)))
}

#[inline]
pub fn add(a: Vec3, b: Vec3) -> Vec3 {
    vp(pv(a).Add(pv(b)))
}

#[inline]
pub fn scale(a: Vec3, s: f64) -> Vec3 {
    vp(pv(a).Scale(s))
}

#[inline]
pub fn cross(a: Vec3, b: Vec3) -> Vec3 {
    vp(pv(a).Cross(pv(b)))
}

#[inline]
pub fn dot(a: Vec3, b: Vec3) -> f64 {
    pv(a).Dot(pv(b))
}

#[inline]
pub fn dist_sq(a: Vec3, b: Vec3) -> f64 {
    pv(a).DistSq(pv(b))
}

#[inline]
pub fn mid(a: Vec3, b: Vec3) -> Vec3 {
    vp(pv(a).Mid(pv(b)))
}

#[inline]
pub fn centroid(a: Vec3, b: Vec3, c: Vec3) -> Vec3 {
    vp(pv(a).Centroid(pv(b), pv(c)))
}

// ---- aabb surface -----------------------------------------------------------

impl Aabb {
    #[inline]
    pub fn new(min: [f64; 3], max: [f64; 3]) -> Self {
        Self { min, max }
    }

    #[inline]
    pub fn inflate(&self, m: f64) -> Aabb {
        bp(pb(self).Inflate(m))
    }

    #[inline]
    pub fn center(&self) -> Vec3 {
        vp(pb(self).Center())
    }

    #[inline]
    pub fn intersects(&self, b: &Aabb) -> bool {
        pb(self).Intersects(pb(b))
    }
}

#[inline]
pub fn signed_gap(a: &Aabb, b: &Aabb) -> f64 {
    pb(a).SignedGap(pb(b))
}

#[inline]
pub fn overlap_bounds(a: &Aabb, b: &Aabb) -> Aabb {
    bp(pb(a).OverlapBounds(pb(b)))
}

#[inline]
pub fn bounds_of_points(a: Vec3, b: Vec3) -> Aabb {
    bp(pv(a).BoundsOfPoints(pv(b)))
}

#[inline]
pub fn aabb_contains(outer: &Aabb, inner: &Aabb) -> bool {
    pb(outer).Contains(pb(inner))
}

// ---- triangle surface --------------------------------------------------------

#[inline]
pub fn tri_tri_intersect(a0: Vec3, a1: Vec3, a2: Vec3, b0: Vec3, b1: Vec3, b2: Vec3) -> bool {
    pv(a0).TriTriIntersect(pv(a1), pv(a2), pv(b0), pv(b1), pv(b2))
}
