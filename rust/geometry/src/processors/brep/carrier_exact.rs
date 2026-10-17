// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exact binary64 source geometry; no geometric tolerance (#7714).

use num_rational::BigRational;
use num_traits::{ToPrimitive, Zero};

pub(super) type R = BigRational;
pub(super) type P = [R; 3];

pub(super) fn point(p: &crate::Point3<f64>) -> Option<P> {
    Some([
        R::from_float(p.x)?,
        R::from_float(p.y)?,
        R::from_float(p.z)?,
    ])
}
pub(super) fn rounded(p: &P) -> Option<crate::Point3<f64>> {
    let q = crate::Point3::new(p[0].to_f64()?, p[1].to_f64()?, p[2].to_f64()?);
    // Restrict the first domain to intersections exactly representable in
    // binary64. Rounding must never move a healthy incident carrier.
    (point(&q)?.eq(p)).then_some(q)
}
pub(super) fn sub(a: &P, b: &P) -> P {
    std::array::from_fn(|i| &a[i] - &b[i])
}
pub(super) fn cross(a: &P, b: &P) -> P {
    [
        &a[1] * &b[2] - &a[2] * &b[1],
        &a[2] * &b[0] - &a[0] * &b[2],
        &a[0] * &b[1] - &a[1] * &b[0],
    ]
}
pub(super) fn dot(a: &P, b: &P) -> R {
    (0..3).map(|i| &a[i] * &b[i]).sum()
}
pub(super) fn zero(p: &P) -> bool {
    p.iter().all(Zero::is_zero)
}

#[derive(Clone)]
pub(super) struct Plane {
    pub n: P,
    pub d: R,
}

impl Plane {
    pub fn through(ring: &[P]) -> Option<Self> {
        let a = ring.first()?;
        for i in 1..ring.len().checked_sub(1)? {
            let n = cross(&sub(&ring[i], a), &sub(&ring[i + 1], a));
            if !zero(&n) {
                return Some(Self { d: dot(&n, a), n });
            }
        }
        None
    }
    pub fn side(&self, p: &P) -> R {
        dot(&self.n, p) - &self.d
    }
    pub fn contains(&self, p: &P) -> bool {
        self.side(p).is_zero()
    }
    pub fn same(&self, other: &Self) -> bool {
        zero(&cross(&self.n, &other.n))
            && (0..3).all(|i| &self.n[i] * &other.d == &other.n[i] * &self.d)
    }
}

pub(super) fn area_vector(ring: &[P]) -> P {
    let mut n = std::array::from_fn(|_| R::zero());
    for i in 0..ring.len() {
        let term = cross(&ring[i], &ring[(i + 1) % ring.len()]);
        for j in 0..3 {
            n[j] += &term[j];
        }
    }
    n
}

pub(super) fn intersection(planes: &[&Plane]) -> Option<P> {
    // At most 32 incident carriers, bounded by the source shell admission.
    for a in 0..planes.len() {
        for b in a + 1..planes.len() {
            for c in b + 1..planes.len() {
                let (a, b, c) = (planes[a], planes[b], planes[c]);
                let bc = cross(&b.n, &c.n);
                let determinant = dot(&a.n, &bc);
                if determinant.is_zero() {
                    continue;
                }
                let ca = cross(&c.n, &a.n);
                let ab = cross(&a.n, &b.n);
                let p = std::array::from_fn(|i| {
                    (&a.d * &bc[i] + &b.d * &ca[i] + &c.d * &ab[i]) / &determinant
                });
                return planes.iter().all(|plane| plane.contains(&p)).then_some(p);
            }
        }
    }
    None
}
