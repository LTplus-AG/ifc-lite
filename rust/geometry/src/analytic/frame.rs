// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Endpoints and traversal tangents shared by analytic consumers.

use super::AnalyticCurveSegment;

/// A world-space point kept as an origin and a local offset. Comparing nearby
/// points this way retains small arc offsets at large georeferenced origins.
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub struct AnalyticPoint {
    pub origin: [f64; 3],
    pub offset: [f64; 3],
}

impl AnalyticPoint {
    /// Distance in world metres, subtracting origins before local offsets.
    pub fn distance_to(self, other: Self) -> Option<f64> {
        let delta = std::array::from_fn::<_, 3, _>(|axis| {
            (self.origin[axis] - other.origin[axis]) + (self.offset[axis] - other.offset[axis])
        });
        let length = delta[0].hypot(delta[1]).hypot(delta[2]);
        length.is_finite().then_some(length)
    }
}

/// Endpoints and unit tangents in directrix traversal direction. A zero-length
/// line or zero-sweep arc has no defined tangent.
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub struct AnalyticSegmentFrame {
    pub start: AnalyticPoint,
    pub end: AnalyticPoint,
    pub start_tangent: Option<[f64; 3]>,
    pub end_tangent: Option<[f64; 3]>,
}

impl AnalyticCurveSegment {
    /// Evaluate the source curve in its current coordinate space. Returns
    /// `None` for non-finite or invalid curve frames.
    pub fn endpoint_frame(&self) -> Option<AnalyticSegmentFrame> {
        match self {
            Self::Line { start, end } => {
                let delta = std::array::from_fn::<_, 3, _>(|axis| end[axis] - start[axis]);
                let length = delta[0].hypot(delta[1]).hypot(delta[2]);
                if !length.is_finite() || !start.iter().chain(end).all(|value| value.is_finite()) {
                    return None;
                }
                let tangent = (length > 0.0).then(|| delta.map(|value| value / length));
                Some(AnalyticSegmentFrame {
                    start: AnalyticPoint { origin: *start, offset: [0.0; 3] },
                    end: AnalyticPoint { origin: *end, offset: [0.0; 3] },
                    start_tangent: tangent,
                    end_tangent: tangent,
                })
            }
            Self::Arc { center, normal, x_axis, radius, start_angle, sweep_angle } => {
                if !center.iter().chain(normal).chain(x_axis).all(|v| v.is_finite())
                    || !radius.is_finite() || *radius <= 0.0
                    || !start_angle.is_finite() || !sweep_angle.is_finite()
                {
                    return None;
                }
                let y_axis = [
                    normal[1] * x_axis[2] - normal[2] * x_axis[1],
                    normal[2] * x_axis[0] - normal[0] * x_axis[2],
                    normal[0] * x_axis[1] - normal[1] * x_axis[0],
                ];
                let end_angle = start_angle + sweep_angle;
                if !end_angle.is_finite() { return None; }
                let at = |angle: f64| {
                    let (sin, cos) = angle.sin_cos();
                    let offset = std::array::from_fn::<_, 3, _>(|axis| {
                        radius * (cos * x_axis[axis] + sin * y_axis[axis])
                    });
                    let tangent = std::array::from_fn::<_, 3, _>(|axis| {
                        sweep_angle.signum() * (-sin * x_axis[axis] + cos * y_axis[axis])
                    });
                    (AnalyticPoint { origin: *center, offset }, tangent)
                };
                let (start, start_tangent) = at(*start_angle);
                let (end, end_tangent) = at(end_angle);
                if !start.offset.iter().chain(end.offset.iter())
                    .chain(start_tangent.iter()).chain(end_tangent.iter())
                    .all(|v| v.is_finite())
                { return None; }
                let tangent = |vector: [f64; 3]| {
                    let length = vector[0].hypot(vector[1]).hypot(vector[2]);
                    (length > 0.0 && length.is_finite()).then(|| vector.map(|v| v / length))
                };
                Some(AnalyticSegmentFrame {
                    start, end,
                    start_tangent: (*sweep_angle != 0.0).then(|| tangent(start_tangent)).flatten(),
                    end_tangent: (*sweep_angle != 0.0).then(|| tangent(end_tangent)).flatten(),
                })
            }
        }
    }
}
