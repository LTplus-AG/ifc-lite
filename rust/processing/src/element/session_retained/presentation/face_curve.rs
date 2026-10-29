// SPDX-License-Identifier: MPL-2.0
//! The swept-disk directrix of M11-F face attribution (#7955): a clamped
//! rational B-spline in homogeneous form. Foot-point searches charge the
//! product budget for every evaluation they perform, so a long directrix
//! refuses on budget instead of running into the product deadline.
use ifc_lite_geometry::resource::{self, ProgramStop};

/// The request encoding's own bound (`document/retained_disk.rs`).
pub(crate) const MAX_DEGREE: usize = 32;
/// Samples per knot span, then golden-section steps around the best one.
const SAMPLES: usize = 32;
const REFINE: usize = 60;

/// One non-empty knot span inside the active range, with the bounding box of
/// its control points: positive weights keep the span inside their hull.
#[derive(Debug, Clone)]
struct Span { t: [f64; 2], low: [f64; 3], high: [f64; 3] }
impl Span {
    fn bound(&self, q: [f64; 3]) -> f64 {
        (0..3).map(|i| (self.low[i] - q[i]).max(q[i] - self.high[i]).max(0.).powi(2)).sum()
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Curve {
    degree: usize,
    points: Vec<[f64; 4]>,
    knots: Vec<f64>,
    range: [f64; 2],
    /// Every `s` in `degree..points` with `knots[s] < knots[s + 1]`, ascending.
    starts: Vec<usize>,
    active: Vec<Span>,
}
fn charge(work: u64) -> Result<(), ProgramStop> {
    resource::charge(resource::Cost { work, ..Default::default() })?.retain();
    Ok(())
}

impl Curve {
    /// `points` are weight-multiplied `[x w, y w, z w, w]`; `knots` are expanded.
    pub(crate) fn new(degree: usize, points: Vec<[f64; 4]>, knots: Vec<f64>, range: [f64; 2]) -> Option<Self> {
        if degree == 0 || degree > MAX_DEGREE || knots.len() != points.len() + degree + 1 || !(range[0] < range[1])
            || knots.windows(2).any(|w| !(w[0] <= w[1])) || points.iter().any(|p| !(p[3] > 0.)) { return None; }
        let starts: Vec<usize> = (degree..points.len()).filter(|&s| knots[s] < knots[s + 1]).collect();
        let active = starts.iter().filter_map(|&s| {
            let t = [knots[s].max(range[0]), knots[s + 1].min(range[1])];
            let hull = points[s - degree..=s].iter().map(|h| [h[0] / h[3], h[1] / h[3], h[2] / h[3]]);
            let (low, high) = hull.fold(([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]), |(lo, hi), p| {
                (std::array::from_fn(|i| lo[i].min(p[i])), std::array::from_fn(|i| hi[i].max(p[i])))
            });
            (t[0] < t[1]).then_some(Span { t, low, high })
        }).collect();
        Some(Self { degree, points, knots, range, starts, active })
    }
    /// The same curve data, bit for bit.
    pub(crate) fn same(&self, other: &Self) -> bool {
        self.degree == other.degree && self.range == other.range && self.points == other.points && self.knots == other.knots
    }
    /// Work charged once when the curve is built (its span hulls).
    pub(crate) fn setup_cost(&self) -> usize { self.points.len() + self.active.len() * (self.degree + 1) }
    /// One unit per de Boor blend, plus the span search.
    fn evaluation_cost(&self) -> u64 { (self.degree * (self.degree + 1) / 2 + 1) as u64 }

    pub(crate) fn point(&self, t: f64) -> [f64; 3] {
        let (p, k) = (self.degree, &self.knots);
        let t = t.clamp(self.range[0], self.range[1]);
        // The last span s with k[s] <= t, so the last parameter uses the last span.
        let s = self.starts.partition_point(|&s| k[s] <= t).checked_sub(1).map_or(p, |i| self.starts[i]);
        let mut d = [[0.; 4]; MAX_DEGREE + 1];
        d[..=p].copy_from_slice(&self.points[s - p..=s]);
        for r in 1..=p {
            for j in (r..=p).rev() {
                let i = s - p + j;
                let a = (t - k[i]) / (k[i + p + 1 - r] - k[i]);
                d[j] = std::array::from_fn(|c| (1. - a) * d[j - 1][c] + a * d[j][c]);
            }
        }
        let h = d[p];
        [h[0] / h[3], h[1] / h[3], h[2] / h[3]]
    }
    /// Unit tangent by a one-sided difference inside the range.
    pub(crate) fn tangent(&self, t: f64) -> Option<[f64; 3]> {
        let h = (self.range[1] - self.range[0]) * 1e-7;
        let (a, b) = if t + h <= self.range[1] { (t, t + h) } else { (t - h, t) };
        let (pa, pb) = (self.point(a), self.point(b));
        super::face_attribution::unit([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]])
    }
    /// Foot point on the curve: dense samples on every span whose control hull
    /// could hold a nearer point (nearest hull first), then golden-section
    /// refinement around the best sample. Each batch is charged before it runs.
    pub(crate) fn closest(&self, q: [f64; 3]) -> Result<[f64; 3], ProgramStop> {
        let distance = |t: f64| { let p = self.point(t); (0..3).map(|i| (p[i] - q[i]).powi(2)).sum::<f64>() };
        charge(self.active.len() as u64)?;
        let mut order: Vec<(f64, usize)> = self.active.iter().map(|span| span.bound(q)).zip(0..).collect();
        order.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        let (mut least, mut best, mut step) = (f64::INFINITY, self.range[0], 0.);
        for (bound, i) in order {
            if bound > least { break; }
            charge((SAMPLES as u64 + 1) * self.evaluation_cost())?;
            let [a, b] = self.active[i].t;
            for j in 0..=SAMPLES {
                let t = a + (b - a) * j as f64 / SAMPLES as f64;
                let d = distance(t);
                // Ties keep the smallest parameter, as one ordered sweep would.
                if d < least || (d == least && t < best) { (least, best, step) = (d, t, (b - a) / SAMPLES as f64); }
            }
        }
        charge((REFINE as u64 + 3) * self.evaluation_cost())?;
        let (mut lo, mut hi) = ((best - step).max(self.range[0]), (best + step).min(self.range[1]));
        let ratio = (5f64.sqrt() - 1.) / 2.;
        let (mut a, mut b) = (hi - ratio * (hi - lo), lo + ratio * (hi - lo));
        let (mut fa, mut fb) = (distance(a), distance(b));
        for _ in 0..REFINE {
            if fa <= fb { (hi, b, fb) = (b, a, fa); a = hi - ratio * (hi - lo); fa = distance(a); }
            else { (lo, a, fa) = (a, b, fb); b = lo + ratio * (hi - lo); fb = distance(b); }
        }
        let refined = (lo + hi) / 2.;
        Ok(self.point(if distance(refined) <= least { refined } else { best }))
    }
}
