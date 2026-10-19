// SPDX-License-Identifier: MPL-2.0
//! Existing BigRational exact dyadic arithmetic, with pre-operation bit bounds.
use super::*;
use num_traits::{One, Zero};
pub(super) type R = BigRational;
pub(super) struct Budget {
    left: u64,
}
impl Budget {
    pub fn new(limits: RegionLimits) -> Self {
        Self {
            left: limits.work.min(MAX_REGION_WORK),
        }
    }
    pub fn tick(&mut self, work: u64) -> Result<(), RegionError> {
        resource::check_current()?;
        if work > self.left {
            return Err(resource::refused(
                resource::Dimension::Work,
                work,
                self.left,
                resource::RefusalReason::Limit,
            )
            .into());
        }
        self.left -= work;
        resource::charge(resource::Cost {
            work,
            ..Default::default()
        })?
        .retain();
        Ok(())
    }
    fn bound(&mut self, n: u64, d: u64) -> Result<(), RegionError> {
        if n > MAX_RATIONAL_BITS || d > MAX_RATIONAL_BITS {
            return Err(resource::refused(
                resource::Dimension::Representation,
                n.max(d),
                MAX_RATIONAL_BITS,
                resource::RefusalReason::Limit,
            )
            .into());
        }
        self.tick(1 + (n.max(d) / 64).pow(2))
    }
    pub fn remaining(&self) -> u64 {
        self.left
    }
    pub fn topology_spent(&mut self, work: u64) -> Result<(), RegionError> {
        self.left = self.left.checked_sub(work).ok_or_else(resource::overflow)?;
        resource::check_current()?;
        Ok(())
    }
    pub fn r(&mut self, x: f64) -> Result<R, RegionError> {
        self.tick(1)?;
        if !x.is_finite() {
            return Err(refused(RegionRefusal::Nonfinite));
        }
        // A finite f64 has at most 1075 denominator bits and 1024 numerator
        // bits. Admit that fixed conversion envelope before allocating limbs.
        self.bound(1024, 1075)?;
        R::from_float(x).ok_or_else(|| refused(RegionRefusal::Nonfinite))
    }
    pub fn add(&mut self, a: &R, b: &R) -> Result<R, RegionError> {
        self.bound(
            (a.numer().bits() + b.denom().bits()).max(b.numer().bits() + a.denom().bits()) + 1,
            a.denom().bits() + b.denom().bits(),
        )?;
        Ok(a + b)
    }
    pub fn sub(&mut self, a: &R, b: &R) -> Result<R, RegionError> {
        self.bound(
            (a.numer().bits() + b.denom().bits()).max(b.numer().bits() + a.denom().bits()) + 1,
            a.denom().bits() + b.denom().bits(),
        )?;
        Ok(a - b)
    }
    pub fn mul(&mut self, a: &R, b: &R) -> Result<R, RegionError> {
        self.bound(
            a.numer().bits() + b.numer().bits(),
            a.denom().bits() + b.denom().bits(),
        )?;
        Ok(a * b)
    }
    pub fn div(&mut self, a: &R, b: &R) -> Result<R, RegionError> {
        if b.is_zero() {
            return Err(refused(RegionRefusal::Degenerate));
        }
        self.bound(
            a.numer().bits() + b.denom().bits(),
            a.denom().bits() + b.numer().bits(),
        )?;
        Ok(a / b)
    }
    pub fn cmp(&mut self, a: &R, b: &R) -> Result<std::cmp::Ordering, RegionError> {
        self.bound(
            a.numer().bits() + b.denom().bits(),
            b.numer().bits() + a.denom().bits(),
        )?;
        Ok(a.cmp(b))
    }
    pub fn orient(&mut self, a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> Result<R, RegionError> {
        let [ax, ay] = [self.r(a[0])?, self.r(a[1])?];
        let [bx, by] = [self.r(b[0])?, self.r(b[1])?];
        let [cx, cy] = [self.r(c[0])?, self.r(c[1])?];
        let x = self.sub(&bx, &ax)?;
        let y = self.sub(&by, &ay)?;
        let u = self.sub(&cx, &ax)?;
        let v = self.sub(&cy, &ay)?;
        let p = self.mul(&x, &v)?;
        let q = self.mul(&y, &u)?;
        self.sub(&p, &q)
    }
    pub fn parameter(
        &mut self,
        a: [f64; 2],
        b: [f64; 2],
        p: [f64; 2],
    ) -> Result<Option<R>, RegionError> {
        if !self.orient(a, b, p)?.is_zero() {
            return Ok(None);
        }
        let axis = if a[0] != b[0] { 0 } else { 1 };
        let x = self.r(p[axis])?;
        let o = self.r(a[axis])?;
        let e = self.r(b[axis])?;
        let n = self.sub(&x, &o)?;
        let d = self.sub(&e, &o)?;
        let t = self.div(&n, &d)?;
        if self.cmp(&t, &R::zero())?.is_lt() || self.cmp(&t, &R::one())?.is_gt() {
            Ok(None)
        } else {
            Ok(Some(t))
        }
    }
    pub fn area2(
        &mut self,
        edges: impl Iterator<Item = ([f64; 2], [f64; 2])>,
    ) -> Result<R, RegionError> {
        let mut area = R::zero();
        for (a, b) in edges {
            let ax = self.r(a[0])?;
            let ay = self.r(a[1])?;
            let bx = self.r(b[0])?;
            let by = self.r(b[1])?;
            let p = self.mul(&ax, &by)?;
            let q = self.mul(&bx, &ay)?;
            let term = self.sub(&p, &q)?;
            area = self.add(&area, &term)?;
        }
        Ok(area)
    }
}
