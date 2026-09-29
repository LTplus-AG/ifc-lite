// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Enclosures of analytic curves, never sampled polygons. #6316.
//! Arithmetic widens outward using the existing exact-kernel interval tier.
//! Trigonometry uses a Taylor enclosure, not an assumed libm error bound.

use crate::kernel::interval::{next_down, next_up, RnInterval as I};
use super::AnalyticCurveSegment;

pub(super) type Box2 = [I; 2];
pub(super) fn point(x: f64) -> I { I::point(x) }
pub(super) fn range(lo: f64, hi: f64) -> I { I { lo, hi } }
pub(super) fn finite(x: I) -> bool { x.lo.is_finite() && x.hi.is_finite() && x.lo <= x.hi }
fn divide(x: I, d: f64) -> I { range(next_down(x.lo / d), next_up(x.hi / d)) }

fn trig(x: I, cosine: bool) -> Result<I, String> {
    if !finite(x) || x.lo < -16.0 || x.hi > 16.0 {
        return Err("profile topology: angle outside certified interval domain".into());
    }
    // 60 terms; |x| <= 16. Taylor's absolute remainder is below 1e-50
    // for both degrees (119/118). Arithmetic/coefficients are enclosed too.
    let negative_square = x.mul(x).mul(point(-1.0));
    let mut term = if cosine { point(1.0) } else { x };
    let mut sum = term;
    for k in 1..60 {
        let n = if cosine { 2 * k } else { 2 * k + 1 };
        term = divide(term.mul(negative_square), (n * (n - 1)) as f64);
        sum = sum.add(term);
    }
    let result = sum.add(range(-1e-50, 1e-50));
    finite(result).then_some(result).ok_or_else(|| "profile topology: non-finite trigonometric enclosure".into())
}

pub(super) fn dot(a: Box2, b: [f64; 2]) -> I {
    a[0].mul(point(b[0])).add(a[1].mul(point(b[1])))
}

/// Internal coordinates retain the original f64 values; all subtractions and
/// curve evaluations occur inside outward-rounded intervals.
pub(super) struct Curve<'a> {
    pub segment: &'a AnalyticCurveSegment,
    origin: [f64; 2],
}

impl<'a> Curve<'a> {
    pub fn new(segment: &'a AnalyticCurveSegment, origin: [f64; 2]) -> Result<Self, String> {
        if segment.length().is_none_or(|length| length <= 0.0) {
            return Err("profile topology: degenerate segment".into());
        }
        if let AnalyticCurveSegment::Arc { sweep_angle, .. } = segment {
            if sweep_angle.abs() > std::f64::consts::TAU {
                return Err("profile topology: arc traverses more than one turn".into());
            }
        }
        Ok(Self { segment, origin })
    }

    pub fn resolved_at(&self, precision: f64) -> Result<bool, String> {
        if let AnalyticCurveSegment::Arc { radius, sweep_angle, .. } = self.segment {
            if *radius <= precision { return Ok(false); }
            if sweep_angle.abs() == std::f64::consts::TAU { return Ok(true); }
        }
        let start = self.at(0.0)?;
        let end = self.at(1.0)?;
        let delta = [end[0].sub(start[0]),end[1].sub(start[1])];
        let square = delta[0].mul(delta[0]).add(delta[1].mul(delta[1]));
        Ok(square.lo > point(precision).mul(point(precision)).hi)
    }

    pub fn at(&self, t: f64) -> Result<Box2, String> { self.bounds(t, t, false) }

    pub fn bounds(&self, lo: f64, hi: f64, derivative: bool) -> Result<Box2, String> {
        let result = match self.segment {
            AnalyticCurveSegment::Line { start, end } => std::array::from_fn(|i| {
                let delta = point(end[i]).sub(point(start[i]));
                if derivative { delta } else {
                    point(start[i]).sub(point(self.origin[i])).add(delta.mul(range(lo, hi)))
                }
            }),
            AnalyticCurveSegment::Arc { center, normal, x_axis, radius, start_angle, sweep_angle } => {
                let mid = (lo + hi) * 0.5;
                let angle = point(*start_angle).add(point(*sweep_angle).mul(point(mid)));
                // sin and cos are 1-Lipschitz: enlarge a point enclosure by
                // the entire angular span. No chord ever certifies a curve.
                let span = point(*sweep_angle).mul(range(lo, hi).sub(point(mid)));
                let width = span.lo.abs().max(span.hi.abs());
                let sin = trig(angle, false)?.add(range(-width, width));
                let cos = trig(angle, true)?.add(range(-width, width));
                let x = [point(x_axis[0]), point(x_axis[1])];
                let y = [point(normal[1]).mul(point(x_axis[2])).sub(point(normal[2]).mul(point(x_axis[1]))),
                    point(normal[2]).mul(point(x_axis[0])).sub(point(normal[0]).mul(point(x_axis[2])))];
                std::array::from_fn(|i| {
                    if derivative {
                        sin.mul(x[i]).mul(point(-1.0)).add(cos.mul(y[i]))
                            .mul(point(*radius)).mul(point(*sweep_angle))
                    } else {
                        point(center[i]).sub(point(self.origin[i]))
                            .add(cos.mul(x[i]).add(sin.mul(y[i])).mul(point(*radius)))
                    }
                })
            }
        };
        if result.iter().all(|value| finite(*value)) { Ok(result) }
        else { Err("profile topology: non-finite curve enclosure".into()) }
    }
}

pub(super) fn separated(a: Box2, b: Box2, clearance: f64) -> bool {
    (0..2).any(|i| a[i].sub(b[i]).lo > clearance || b[i].sub(a[i]).lo > clearance)
}

pub(super) fn width(b: Box2) -> f64 {
    (b[0].hi - b[0].lo).max(b[1].hi - b[1].lo)
}
