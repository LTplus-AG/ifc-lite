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
}

impl ArcLengthMap {
    pub(crate) fn new(alignment: &AlignmentCurve) -> Self {
        let breaks = alignment.station_breaks();
        let mut stations = vec![0.0];
        let mut lengths = vec![0.0];
        let step = (alignment.horizontal_length() / 100_000.0).max(1.0);
        for pair in breaks.windows(2) {
            let span = pair[1] - pair[0];
            let count = ((span / step).ceil() as usize).max(1);
            for i in 1..=count {
                let a = *stations.last().unwrap_or(&pair[0]);
                let b = pair[0] + span * (i as f64 / count as f64);
                let middle = (a + b) * 0.5;
                let speed = |s: f64| {
                    let z = alignment.evaluate(s).tangent.z;
                    1.0 / (1.0 - z * z).sqrt().max(1e-12)
                };
                let epsilon = (b - a) * 1e-6;
                let delta = (b - a) * (speed(a + epsilon) + 4.0 * speed(middle) + speed(b - epsilon)) / 6.0;
                stations.push(b);
                lengths.push(lengths.last().copied().unwrap_or(0.0) + delta);
            }
        }
        Self { stations, lengths }
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
        self.stations[i - 1] + t * (self.stations[i] - self.stations[i - 1])
    }
}
