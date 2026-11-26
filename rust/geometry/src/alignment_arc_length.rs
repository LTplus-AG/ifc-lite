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
    /// The intervals near a vertical station, in sample order (see [`Warp`]).
    warps: Vec<Warp>,
}

/// An interval ending at `b` within [`NEAR_POLE`] of its widths from a
/// station `pole` where the profile is vertical, sampled at `pieces` equal
/// steps of t in u = sqrt(|h - pole|), from `ua` to `ub`. `side` is -1 when
/// the pole lies after the interval and +1 when before. Its samples start at
/// index `first`.
struct Warp {
    first: usize,
    b: f64,
    pole: f64,
    side: f64,
    ua: f64,
    ub: f64,
    pieces: usize,
}

/// How close, in interval widths, a vertical station makes an interval steep
/// enough to need [`Warp`]. Further out Simpson's relative error on a speed
/// that grows like 1/sqrt of the distance is below 1e-6.
const NEAR_POLE: f64 = 8.0;

impl Warp {
    /// The warp of `[a, b]` toward `pole`, when the pole is near enough.
    fn near(first: usize, a: f64, b: f64, pole: f64) -> Option<Self> {
        let after = pole > 0.5 * (a + b);
        let gap = if after { pole - b } else { a - pole };
        (gap < NEAR_POLE * (b - a)).then(|| Self {
            first,
            b,
            pole,
            side: if after { -1.0 } else { 1.0 },
            ua: (a - pole).abs().sqrt(),
            ub: (b - pole).abs().sqrt(),
            pieces: if gap < b - a { 64 } else { 16 },
        })
    }

    /// Station and dh/dt at t, with u linear in t and h = pole -/+ u^2. The
    /// speed grows like 1/u near the pole and dh/dt is proportional to u, so
    /// their product is smooth whether or not the interval reaches the pole.
    fn station(&self, t: f64) -> (f64, f64) {
        let u = self.ua + (self.ub - self.ua) * t;
        (self.pole + self.side * u * u, 2.0 * self.side * u * (self.ub - self.ua))
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
        // A profile is vertical only where it ends, at a break (beyond a
        // circular segment's vertical end the height is not finite). The
        // speed steepens toward it across any breaks in between, so the
        // intervals near it are chosen by their distance to it.
        let poles: Vec<f64> = breaks.iter().copied().filter(|&s| speed(s) >= 1e12).collect();
        for pair in breaks.windows(2) {
            let span = pair[1] - pair[0];
            let count = ((span / step).ceil() as usize).max(1);
            for i in 1..=count {
                let a = *stations.last().unwrap_or(&pair[0]);
                let b = pair[0] + span * (i as f64 / count as f64);
                // Poles are at breaks, so never inside an interval; the
                // nearer one is the one with the smaller |u| at an end.
                let near = poles
                    .iter()
                    .filter_map(|&pole| Warp::near(stations.len() - 1, a, b, pole))
                    .min_by(|x, y| x.ua.min(x.ub).total_cmp(&y.ua.min(y.ub)));
                if let Some(warp) = near {
                    toward_vertical(alignment, &warp, &mut stations, &mut lengths);
                    warps.push(warp);
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
        // Inside an interval near a vertical station the length is smooth
        // in t, not in station: interpolate t and map it to the station.
        let w = self.warps.partition_point(|w| w.first + w.pieces < i);
        if let Some(warp) = self.warps.get(w).filter(|warp| warp.first < i) {
            return warp.station(((i - 1 - warp.first) as f64 + t) / warp.pieces as f64).0;
        }
        self.stations[i - 1] + t * (self.stations[i] - self.stations[i - 1])
    }
}

/// Samples of an interval near a vertical station (a circular profile
/// reaching 90 degrees). The speed grows like 1/sqrt of the distance to that
/// station, which Simpson's rule cannot integrate. [`Warp::station`] cancels
/// that growth, so the integrand in t is smooth and nonzero. Its `pieces` in
/// t are summed by 4-point Gauss-Legendre, which never evaluates an end, and
/// each is recorded. The speed is the reciprocal of the tangent's horizontal
/// part, exact near vertical where 1 - z^2 cancels.
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
