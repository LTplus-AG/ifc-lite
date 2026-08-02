// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 3-component f64 vector helpers.
//!
//! The vector math itself lives in the Plato-generated `generated::plato::Vec3`
//! (from `tools/plato/clash_math.plato`); these functions are byte-compatible
//! adapters that keep the crate's `[f64; 3]` value shape and stable function
//! signatures. All clash math runs in `f64` even though geometry is sourced from
//! `f32` buffers.

use crate::generated::plato::Vec3 as PlatoVec3;

/// A 3-component vector stored as `[x, y, z]`.
pub type Vec3 = [f64; 3];

/// Pack the crate's `[f64; 3]` into the generated struct.
#[inline]
fn pack(v: Vec3) -> PlatoVec3 {
    PlatoVec3::new(v[0], v[1], v[2])
}

/// Unpack the generated struct back into `[f64; 3]`.
#[inline]
fn unpack(v: PlatoVec3) -> Vec3 {
    [v.X, v.Y, v.Z]
}

#[inline]
pub fn sub(a: Vec3, b: Vec3) -> Vec3 {
    unpack(pack(a).Sub(pack(b)))
}

#[inline]
pub fn add(a: Vec3, b: Vec3) -> Vec3 {
    unpack(pack(a).Plus(pack(b)))
}

#[inline]
pub fn scale(a: Vec3, s: f64) -> Vec3 {
    unpack(pack(a).Scale(s))
}

#[inline]
pub fn cross(a: Vec3, b: Vec3) -> Vec3 {
    unpack(pack(a).Cross(pack(b)))
}

#[inline]
pub fn dot(a: Vec3, b: Vec3) -> f64 {
    pack(a).Dot(pack(b))
}

#[inline]
pub fn dist_sq(a: Vec3, b: Vec3) -> f64 {
    pack(a).DistSq(pack(b))
}

#[inline]
pub fn mid(a: Vec3, b: Vec3) -> Vec3 {
    unpack(pack(a).Mid(pack(b)))
}

#[inline]
pub fn centroid(a: Vec3, b: Vec3, c: Vec3) -> Vec3 {
    unpack(pack(a).Centroid(pack(b), pack(c)))
}
