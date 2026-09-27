// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Measurements derived from complete world-space analytic directrices.

use ifc_lite_geometry::analytic::AnalyticCurveSegment;
use serde::Serialize;

/// Per-segment measurements in metres and radians, in directrix order.
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
pub struct DirectrixSegmentMetrics {
    /// Index of the corresponding entry in `Directrix`.
    pub segment_index: usize,
    /// Centreline length in metres.
    pub length: f64,
    /// Arc sweep magnitude in radians; absent for a line. The directrix keeps
    /// the signed sweep angle for callers that need traversal orientation.
    pub bend_angle: Option<f64>,
}

/// Measurements of a complete occurrence directrix in absolute IFC world space.
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
pub struct DirectrixMetrics {
    /// Sum of the ordered segment lengths, in metres.
    pub total_length: f64,
    pub segments: Vec<DirectrixSegmentMetrics>,
}

impl DirectrixMetrics {
    pub(super) fn from_segments(segments: &[AnalyticCurveSegment]) -> Result<Self, &'static str> {
        let mut result = Self {
            total_length: 0.0,
            segments: Vec::with_capacity(segments.len()),
        };
        for (segment_index, segment) in segments.iter().enumerate() {
            let (length, bend_angle) = match segment {
                AnalyticCurveSegment::Line { start, end } => {
                    let delta = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
                    (delta[0].hypot(delta[1]).hypot(delta[2]), None)
                }
                AnalyticCurveSegment::Arc { radius, sweep_angle, .. } => {
                    if *radius <= 0.0 {
                        return Err("directrix arc radius is not positive");
                    }
                    let bend_angle = sweep_angle.abs();
                    (radius * bend_angle, Some(bend_angle))
                }
            };
            if !length.is_finite() || bend_angle.is_some_and(|angle| !angle.is_finite()) {
                return Err("directrix measurements are not finite");
            }
            result.total_length += length;
            if !result.total_length.is_finite() {
                return Err("directrix total length is not finite");
            }
            result.segments.push(DirectrixSegmentMetrics { segment_index, length, bend_angle });
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negative_arc_sweep_reports_positive_bend_and_length() {
        let arc = AnalyticCurveSegment::Arc {
            center: [0.0; 3],
            normal: [0.0, 0.0, 1.0],
            x_axis: [1.0, 0.0, 0.0],
            radius: 2.0,
            start_angle: 0.0,
            sweep_angle: -std::f64::consts::PI,
        };
        let metrics = DirectrixMetrics::from_segments(&[arc]).unwrap();
        assert_eq!(metrics.total_length, 2.0 * std::f64::consts::PI);
        assert_eq!(metrics.segments[0].bend_angle, Some(std::f64::consts::PI));
    }

    #[test]
    fn overflowing_line_or_total_has_no_partial_result() {
        let line = |start, end| AnalyticCurveSegment::Line {
            start: [start, 0.0, 0.0],
            end: [end, 0.0, 0.0],
        };
        assert!(DirectrixMetrics::from_segments(&[line(-1e308, 1e308)]).is_err());
        assert!(DirectrixMetrics::from_segments(&[line(0.0, 1e308), line(0.0, 1e308)]).is_err());
    }
}
