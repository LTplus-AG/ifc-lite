// SPDX-License-Identifier: MPL-2.0
//! Bounded numerical region conversion; original records/segments are immutable.
use super::{RegionQualification, RetainedRefusal};
use crate::analytic::{AnalyticCurveSegment, AnalyticProfile};
use std::f64::consts::TAU;

pub(super) struct Curve {
    pub kind: u32,
    pub values: [f64; 12],
}
impl Curve {
    fn reversed(mut self) -> Self {
        if self.kind == 1 {
            for axis in 0..3 {
                self.values.swap(axis, axis + 3);
            }
        } else {
            self.values[10] += self.values[11];
            self.values[11] = -self.values[11];
        }
        self
    }
    fn endpoints(&self) -> ([f64; 2], [f64; 2]) {
        let v = &self.values;
        if self.kind == 1 {
            return ([v[0], v[1]], [v[3], v[4]]);
        }
        let at = |angle: f64| {
            let (sin, cos) = angle.sin_cos();
            [v[0] + v[9] * (v[6] * cos - v[5] * v[7] * sin),
             v[1] + v[9] * (v[7] * cos + v[5] * v[6] * sin)]
        };
        (at(v[10]), at(v[10] + v[11]))
    }
    fn twice_area(&self) -> f64 {
        let (a, b) = self.endpoints();
        if self.kind == 1 {
            a[0] * b[1] - b[0] * a[1]
        } else {
            let v = &self.values;
            v[0] * (b[1] - a[1]) - v[1] * (b[0] - a[0]) + v[5] * v[9] * v[9] * v[11]
        }
    }
}

pub(super) fn lower(
    profile: &AnalyticProfile, anchor: [f64; 3], units: f64,
) -> Result<(Vec<Vec<Curve>>, RegionQualification), RetainedRefusal> {
    let mut loops = Vec::with_capacity(profile.loops.len());
    let mut net_area = 0.0;
    for (index, boundary) in profile.loops.iter().enumerate() {
        let mut curves = boundary.segments.iter().map(|segment| curve(segment, anchor, units))
            .collect::<Result<Vec<_>, _>>()?;
        let mut twice_area = 0.0;
        for (i, item) in curves.iter().enumerate() {
            let (_, end) = item.endpoints();
            let (next, _) = curves[(i + 1) % curves.len()].endpoints();
            if (end[0] - next[0]).hypot(end[1] - next[1]) > 1e-10 {
                return invalid("disconnected numerical boundary");
            }
            if item.kind == 2 && curves.len() != 1 {
                return invalid("full circle must be an isolated boundary");
            }
            twice_area += item.twice_area();
        }
        let source_area = boundary.signed_area * units * units * 2.0;
        if !twice_area.is_finite() || twice_area.abs() <= 1e-18
            || !source_area.is_finite()
            || (source_area - twice_area).abs() > twice_area.abs() * 1e-9 + 1e-18
        {
            return invalid("invalid or inconsistent numerical boundary area");
        }
        // Reverse derived traversal only; retain source order, winding, basis,
        // trim selectors and composite metadata exactly as authored.
        if (twice_area > 0.0) != (index == 0) {
            curves = curves.into_iter().rev().map(Curve::reversed).collect();
        }
        net_area += if index == 0 { twice_area.abs() } else { -twice_area.abs() };
        loops.push(curves);
    }
    if !net_area.is_finite() || net_area <= 1e-18 {
        return invalid("nonpositive numerical region area");
    }
    // Geometry qualification cannot be acquired by merely changing a type name.
    let rectangle = profile.ifc_type_name == "IfcRectangleProfileDef" && loops.len() == 1
        && is_rectangle(&loops[0]);
    let requirement = if rectangle { RegionQualification::Rectangle } else { RegionQualification::OrderedRegion };
    Ok((loops, requirement))
}

fn is_rectangle(curves: &[Curve]) -> bool {
    if curves.len() != 4 || curves.iter().any(|c| c.kind != 1) { return false; }
    let edges: Vec<_> = curves.iter().map(|c| {
        let v = c.values;
        [v[3] - v[0], v[4] - v[1]]
    }).collect();
    (0..4).all(|i| {
        let a = edges[i];
        let b = edges[(i + 1) % 4];
        let opposite = edges[(i + 2) % 4];
        // Parameterized rectangle edges lie on profile X/Y axes, exactly.
        ((a[0] == 0.0 && b[1] == 0.0) || (a[1] == 0.0 && b[0] == 0.0))
            && (a[0] + opposite[0]).abs() <= 1e-12
            && (a[1] + opposite[1]).abs() <= 1e-12
    })
}

fn curve(segment: &AnalyticCurveSegment, anchor: [f64; 3], units: f64) -> Result<Curve, RetainedRefusal> {
    let mut v = [0.0; 12];
    let kind = match segment {
        AnalyticCurveSegment::Line { start, end } => {
            for i in 0..3 {
                v[i] = (start[i] - anchor[i]) * units;
                v[i + 3] = (end[i] - anchor[i]) * units;
            }
            if v[2] != 0.0 || v[5] != 0.0 || (v[3] - v[0]).hypot(v[4] - v[1]) <= 1e-12 {
                return invalid("invalid XY numerical line");
            }
            1
        }
        AnalyticCurveSegment::Arc { center, normal, x_axis, radius, start_angle, sweep_angle } => {
            for i in 0..3 {
                v[i] = (center[i] - anchor[i]) * units;
                v[i + 3] = normal[i];
                v[i + 6] = x_axis[i];
            }
            v[9] = radius * units;
            v[10] = start_angle % TAU;
            v[11] = *sweep_angle;
            if v[2] != 0.0 || v[3] != 0.0 || v[4] != 0.0 || v[5].abs() != 1.0
                || v[8] != 0.0 || (v[6].hypot(v[7]) - 1.0).abs() >= 1e-12 || v[9] <= 1e-12
                || v[0] + v[9] <= v[0] || v[1] + v[9] <= v[1]
            {
                return invalid("invalid XY numerical circular basis");
            }
            if (sweep_angle.abs() - TAU).abs() < 1e-12 { 2 }
            else if sweep_angle.abs() > 1e-12 && sweep_angle.abs() < TAU - 1e-12 { 3 }
            else { return invalid("invalid numerical circular interval"); }
        }
    };
    if v.iter().any(|n| !n.is_finite() || n.abs() > 1e9) {
        return invalid("curve outside local numerical domain");
    }
    Ok(Curve { kind, values: v })
}
fn invalid<T>(reason: &'static str) -> Result<T, RetainedRefusal> {
    Err(RetainedRefusal::InvalidSource(reason))
}
