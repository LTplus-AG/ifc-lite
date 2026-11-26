// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One cumulative 3D arc-length mapping for all consumers of an alignment
//! whose public station is measured along the sloping directrix.

use crate::alignment::AlignmentCurve;

/// Cumulative 3D distance sampled at profile boundaries and at most 1 m
/// apart. Inversion maps file-supplied 3D distance to horizontal station.
pub(crate) struct ArcLengthMap {
    stations: Vec<f64>,
    lengths: Vec<f64>,
    /// The intervals that end vertical, in sample order (see [`Warp`]).
    warps: Vec<Warp>,
}

/// An interval `[a, b]` sampled at `pieces` equal steps of t. Next to a
/// vertical end the station is h = b - (b - a)(1 - t)^2 (vertical at b) or
/// h = a + (b - a)t^2 (at a), otherwise h = a + (b - a)t. Its samples start
/// at index `first`.
struct Warp {
    first: usize,
    a: f64,
    b: f64,
    pieces: usize,
    vertical_at: Option<bool>,
}

impl Warp {
    /// Station and dh/dt at t. The quadratic one vanishes at the vertical
    /// end, where the speed grows like 1/sqrt of the distance to it, and
    /// the product is smooth.
    fn station(&self, t: f64) -> (f64, f64) {
        let span = self.b - self.a;
        match self.vertical_at {
            Some(true) => (self.a + span * t * t, 2.0 * span * t),
            Some(false) => (self.b - span * (1.0 - t) * (1.0 - t), 2.0 * span * (1.0 - t)),
            None => (self.a + span * t, span),
        }
    }
}

impl ArcLengthMap {
    pub(crate) fn new(alignment: &AlignmentCurve) -> Self {
        let breaks = alignment.station_breaks();
        let mut stations = vec![0.0];
        let mut lengths = vec![0.0];
        let mut warps = Vec::new();
        let step = (alignment.horizontal_length() / 100_000.0).max(1.0);
        let speed = |s: f64| {
            let z = alignment.evaluate(s).tangent.z;
            1.0 / (1.0 - z * z).sqrt().max(1e-12)
        };
        for pair in breaks.windows(2) {
            let span = pair[1] - pair[0];
            let count = ((span / step).ceil() as usize).max(1);
            // A profile is vertical only where it ends, at a break (beyond
            // a circular segment's vertical end the height is not finite),
            // so at most one end of an interval is. It steepens the whole
            // span up to that break.
            let vertical = [speed(pair[0]) >= 1e12, speed(pair[1]) >= 1e12];
            for i in 1..=count {
                let a = *stations.last().unwrap_or(&pair[0]);
                let b = pair[0] + span * (i as f64 / count as f64);
                if vertical[0] || vertical[1] {
                    let vertical_at = match (i == 1 && vertical[0], i == count && vertical[1]) {
                        (true, _) => Some(true),
                        (_, true) => Some(false),
                        _ => None,
                    };
                    let pieces = if vertical_at.is_some() { 64 } else { 16 };
                    let warp = Warp { first: stations.len() - 1, a, b, pieces, vertical_at };
                    toward_vertical(alignment, &warp, &mut stations, &mut lengths);
                    warps.extend(warp.vertical_at.is_some().then_some(warp));
                    continue;
                }
                let middle = (a + b) * 0.5;
                let epsilon = (b - a) * 1e-6;
                let delta = (b - a) * (speed(a + epsilon) + 4.0 * speed(middle) + speed(b - epsilon)) / 6.0;
                stations.push(b);
                lengths.push(lengths.last().copied().unwrap_or(0.0) + delta);
            }
        }
        Self { stations, lengths, warps }
    }

    pub(crate) fn horizontal_station(&self, distance: f64) -> f64 {
        if distance <= 0.0 {
            let speed = if self.lengths.len() > 1 {
                (self.lengths[1] - self.lengths[0]) /
                    (self.stations[1] - self.stations[0])
            } else { 1.0 };
            return distance / speed;
        }
        let i = self.lengths.partition_point(|v| *v < distance);
        if i == 0 { return 0.0 }
        if i == self.lengths.len() {
            let last = i - 1;
            let slope = if last > 0 {
                (self.lengths[last] - self.lengths[last - 1]) /
                    (self.stations[last] - self.stations[last - 1])
            } else { 1.0 };
            return self.stations[last] + (distance - self.lengths[last]) / slope;
        }
        let t = (distance - self.lengths[i - 1]) / (self.lengths[i] - self.lengths[i - 1]);
        // Inside an interval at a vertical end the length is smooth in
        // t, not in station: interpolate t and map it to the station.
        let w = self.warps.partition_point(|w| w.first + w.pieces < i);
        if let Some(warp) = self.warps.get(w).filter(|warp| warp.first < i) {
            return warp.station(((i - 1 - warp.first) as f64 + t) / warp.pieces as f64).0;
        }
        self.stations[i - 1] + t * (self.stations[i] - self.stations[i - 1])
    }
}

/// Samples of an interval of a span that ends vertical (a circular profile
/// reaching 90 degrees). The speed grows like 1/sqrt of the distance to
/// that end, which Simpson's rule cannot integrate, and it steepens the
/// whole span. In the interval at the end, [`Warp::station`] cancels the
/// singularity, so the integrand in t is smooth and nonzero. Its `pieces` in
/// t are summed by 4-point Gauss-Legendre, which never evaluates an end, and
/// each is recorded. The speed is the reciprocal of the tangent's
/// horizontal part, exact near vertical where 1 - z^2 cancels.
fn toward_vertical(
    alignment: &AlignmentCurve,
    warp: &Warp,
    stations: &mut Vec<f64>,
    lengths: &mut Vec<f64>,
) {
    const NODES: [(f64, f64); 4] = [
        (-0.861_136_311_594_052_6, 0.347_854_845_137_453_9),
        (-0.339_981_043_584_856_3, 0.652_145_154_862_546_1),
        (0.339_981_043_584_856_3, 0.652_145_154_862_546_1),
        (0.861_136_311_594_052_6, 0.347_854_845_137_453_9),
    ];
    let integrand = |t: f64| {
        let (station, rate) = warp.station(t);
        let tangent = alignment.evaluate(station).tangent;
        rate / tangent.x.hypot(tangent.y)
    };
    for k in 0..warp.pieces {
        let (t0, t1) = (k as f64 / warp.pieces as f64, (k + 1) as f64 / warp.pieces as f64);
        let half = 0.5 * (t1 - t0);
        let piece: f64 = NODES.iter().map(|(x, w)| w * integrand(t0 + half * (1.0 + x))).sum();
        stations.push(if k + 1 == warp.pieces { warp.b } else { warp.station(t1).0 });
        lengths.push(lengths.last().copied().unwrap_or(0.0) + half * piece);
    }
}
