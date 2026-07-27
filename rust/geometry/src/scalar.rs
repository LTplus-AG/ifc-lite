// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Scalar abstraction for the mesher (B4.4, M3 kernel-adjoint spike).
//!
//! The extrusion mesher used to be written directly against `f64`. It is now
//! written against [`GeomScalar`], with `f64` as the production instantiation.
//! Every arithmetic expression is unchanged and every branch is taken on the
//! **primal** value ([`GeomScalar::value`], the identity for `f64`), so the
//! `f64` monomorphisation is bit-for-bit the code that shipped before — a
//! property that `extrusion::byte_identity_tests` asserts against verbatim
//! copies of the pre-refactor functions.
//!
//! The point of the abstraction is that a second instantiation (a forward-mode
//! dual number, see `b44_battery`) can run the *same* mesher and carry
//! derivatives of every emitted vertex coordinate with respect to design
//! parameters. Nothing in the production build pays for it: there is exactly
//! one non-test instantiation, and monomorphisation erases the trait.
//!
//! Where a mesh is written, the mesher writes through [`MeshSink`] rather than
//! into [`crate::mesh::Mesh`] directly. `Mesh` stores `f32`, which is a
//! staircase function of the inputs and therefore not differentiable; the dual
//! sink stores the scalar unrounded. That quantisation is the *only* difference
//! between the two instantiations, and it is measured rather than assumed (see
//! `scripts/moonshot/b44-kernel-adjoint/DESIGN.md`).

use nalgebra::{Matrix4, Point3, Vector3};
use std::fmt::Debug;
use std::ops::{Add, Div, Mul, Neg, Sub};

/// The scalar the mesher is generic over.
///
/// Deliberately minimal: only the operations the extrusion path actually
/// performs. Comparisons are **not** part of the trait — every branch in the
/// mesher compares `x.value()` against a constant, which is the correct
/// piecewise-smooth semantics for a derivative-carrying scalar (the derivative
/// is that of the branch the primal selects) and the identity for `f64`.
pub(crate) trait GeomScalar:
    Copy
    + Clone
    + PartialEq
    + Debug
    + 'static
    + Add<Output = Self>
    + Sub<Output = Self>
    + Mul<Output = Self>
    + Div<Output = Self>
    + Neg<Output = Self>
{
    /// Lift a constant.
    fn from_f64(v: f64) -> Self;
    /// The primal value. Identity for `f64`.
    fn value(self) -> f64;
    fn sqrt(self) -> Self;
    fn abs(self) -> Self;
    fn min(self, other: Self) -> Self;
    fn max(self, other: Self) -> Self;
    #[inline]
    fn is_finite(self) -> bool {
        self.value().is_finite()
    }
}

impl GeomScalar for f64 {
    #[inline]
    fn from_f64(v: f64) -> Self {
        v
    }
    #[inline]
    fn value(self) -> f64 {
        self
    }
    #[inline]
    fn sqrt(self) -> Self {
        f64::sqrt(self)
    }
    #[inline]
    fn abs(self) -> Self {
        f64::abs(self)
    }
    #[inline]
    fn min(self, other: Self) -> Self {
        f64::min(self, other)
    }
    #[inline]
    fn max(self, other: Self) -> Self {
        f64::max(self, other)
    }
}

/// `Vector3::magnitude_squared`, in the same accumulation order nalgebra uses
/// for a 3-element real dot product (`x*x + y*y + z*z`, left-associated).
#[inline]
pub(crate) fn magnitude_squared3<S: GeomScalar>(v: &Vector3<S>) -> S {
    v.x * v.x + v.y * v.y + v.z * v.z
}

/// `Vector3::try_normalize`, replicating nalgebra 0.35's implementation
/// (`n = norm(); if n <= min_norm { None } else { Some(self.unscale(n)) }`).
#[inline]
pub(crate) fn try_normalize3<S: GeomScalar>(v: &Vector3<S>, min_norm: f64) -> Option<Vector3<S>> {
    let n = magnitude_squared3(v).sqrt();
    if n.value() <= min_norm {
        None
    } else {
        Some(Vector3::new(v.x / n, v.y / n, v.z / n))
    }
}

/// `Matrix4::transform_point`, replicating nalgebra 0.35's implementation:
/// `n = m30*x + m31*y + m32*z + m33`, then `(M3x3 * p + t) / n` when `n != 0`.
#[inline]
pub(crate) fn transform_point4<S: GeomScalar>(m: &Matrix4<S>, p: &Point3<S>) -> Point3<S> {
    let (x, y, z) = (p.x, p.y, p.z);
    let n = m[(3, 0)] * x + m[(3, 1)] * y + m[(3, 2)] * z + m[(3, 3)];
    let tx = m[(0, 0)] * x + m[(0, 1)] * y + m[(0, 2)] * z + m[(0, 3)];
    let ty = m[(1, 0)] * x + m[(1, 1)] * y + m[(1, 2)] * z + m[(1, 3)];
    let tz = m[(2, 0)] * x + m[(2, 1)] * y + m[(2, 2)] * z + m[(2, 3)];
    if n.value() != 0.0 {
        Point3::new(tx / n, ty / n, tz / n)
    } else {
        Point3::new(tx, ty, tz)
    }
}

/// The mesh-writing surface the extrusion mesher uses.
///
/// `Mesh` (f32-backed, production) and the spike's dual-number mesh both
/// implement it, so the mesher body is shared verbatim between them.
pub(crate) trait MeshSink<S: GeomScalar> {
    fn vertex_count(&self) -> usize;
    /// Capacity hint only; must not change emitted bytes.
    fn reserve(&mut self, vertices: usize, indices: usize);
    fn add_vertex(&mut self, position: Point3<S>, normal: Vector3<S>);
    fn add_triangle(&mut self, i0: u32, i1: u32, i2: u32);
    /// Read back a previously written position (positions are rewritten in
    /// place by `apply_transform`).
    fn position(&self, index: usize) -> Point3<S>;
    fn set_position(&mut self, index: usize, position: Point3<S>);
    /// Transform the normal buffer. Sink-specific because it needs a 4x4
    /// inverse; normals do not enter any quantity the spike differentiates
    /// (the divergence-theorem volume is a function of positions and indices
    /// only), so the dual sink is free to skip it.
    fn transform_normals(&mut self, transform: &Matrix4<S>);
}

impl MeshSink<f64> for crate::mesh::Mesh {
    #[inline]
    fn vertex_count(&self) -> usize {
        crate::mesh::Mesh::vertex_count(self)
    }
    #[inline]
    fn reserve(&mut self, vertices: usize, indices: usize) {
        self.positions.reserve(vertices * 3);
        self.normals.reserve(vertices * 3);
        self.indices.reserve(indices);
    }
    #[inline]
    fn add_vertex(&mut self, position: Point3<f64>, normal: Vector3<f64>) {
        crate::mesh::Mesh::add_vertex(self, position, normal)
    }
    #[inline]
    fn add_triangle(&mut self, i0: u32, i1: u32, i2: u32) {
        crate::mesh::Mesh::add_triangle(self, i0, i1, i2)
    }
    #[inline]
    fn position(&self, index: usize) -> Point3<f64> {
        Point3::new(
            self.positions[index * 3] as f64,
            self.positions[index * 3 + 1] as f64,
            self.positions[index * 3 + 2] as f64,
        )
    }
    #[inline]
    fn set_position(&mut self, index: usize, position: Point3<f64>) {
        self.positions[index * 3] = position.x as f32;
        self.positions[index * 3 + 1] = position.y as f32;
        self.positions[index * 3 + 2] = position.z as f32;
    }
    #[inline]
    fn transform_normals(&mut self, transform: &Matrix4<f64>) {
        // Verbatim from the pre-refactor `apply_transform` normal loop.
        let normal_matrix = transform.try_inverse().unwrap_or(*transform).transpose();
        self.normals.chunks_exact_mut(3).for_each(|chunk| {
            let normal = Vector3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
            let transformed = (normal_matrix * normal.to_homogeneous()).xyz().normalize();
            chunk[0] = transformed.x as f32;
            chunk[1] = transformed.y as f32;
            chunk[2] = transformed.z as f32;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hand-written `transform_point4` must be bit-identical to nalgebra's
    /// `Matrix4::transform_point` for `f64`, since production now routes
    /// through it.
    #[test]
    fn transform_point4_matches_nalgebra_bitwise() {
        let mut state = 0x9E3779B97F4A7C15u64;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 11) as f64 / (1u64 << 53) as f64 * 20.0 - 10.0
        };
        for _ in 0..2000 {
            let mut m = Matrix4::<f64>::zeros();
            for i in 0..4 {
                for j in 0..4 {
                    m[(i, j)] = next();
                }
            }
            let p = Point3::new(next(), next(), next());
            let a = m.transform_point(&p);
            let b = transform_point4(&m, &p);
            assert_eq!(a.x.to_bits(), b.x.to_bits(), "x mismatch");
            assert_eq!(a.y.to_bits(), b.y.to_bits(), "y mismatch");
            assert_eq!(a.z.to_bits(), b.z.to_bits(), "z mismatch");
        }
        // Affine matrices (bottom row 0,0,0,1) are the production case.
        for _ in 0..2000 {
            let mut m = Matrix4::<f64>::identity();
            for i in 0..3 {
                for j in 0..4 {
                    m[(i, j)] = next();
                }
            }
            let p = Point3::new(next(), next(), next());
            let a = m.transform_point(&p);
            let b = transform_point4(&m, &p);
            assert_eq!(a.x.to_bits(), b.x.to_bits());
            assert_eq!(a.y.to_bits(), b.y.to_bits());
            assert_eq!(a.z.to_bits(), b.z.to_bits());
        }
    }

    #[test]
    fn try_normalize3_matches_nalgebra_bitwise() {
        let mut state = 0xD1B54A32D192ED03u64;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 11) as f64 / (1u64 << 53) as f64 * 4.0 - 2.0
        };
        for _ in 0..4000 {
            let v = Vector3::new(next(), next(), next());
            let a = v.try_normalize(1e-10);
            let b = try_normalize3(&v, 1e-10);
            match (a, b) {
                (None, None) => {}
                (Some(a), Some(b)) => {
                    assert_eq!(a.x.to_bits(), b.x.to_bits());
                    assert_eq!(a.y.to_bits(), b.y.to_bits());
                    assert_eq!(a.z.to_bits(), b.z.to_bits());
                }
                _ => panic!("try_normalize disagreement on {v:?}"),
            }
            assert_eq!(
                v.magnitude_squared().to_bits(),
                magnitude_squared3(&v).to_bits()
            );
        }
    }
}
