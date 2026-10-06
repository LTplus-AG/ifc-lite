// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Detections moved into the model frame (Z up, metres) by the
//! `scanToModel` similarity, before any proposal logic runs. Every later
//! stage measures in that one frame, so a Y-up scan sample, a manual
//! alignment and a georeferenced model all reduce to the same geometry.
pub(crate) use crate::appearance::transfer_math::{cross, dot, sub, Point};
use crate::scan_segmentation::{NormalSource, ScanSegmentationReport};

pub(crate) type V3 = Point;

pub(crate) fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub(crate) fn scale(a: V3, s: f64) -> V3 {
    a.map(|v| v * s)
}

pub(crate) fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}

pub(crate) fn unit(a: V3) -> V3 {
    let length = dot(a, a).sqrt();
    if length > 1e-12 { scale(a, 1. / length) } else { a }
}

/// `x = s R p + t`, validated proper (no reflection) and uniform.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Similarity {
    rotation: [[f64; 3]; 3],
    pub scale: f64,
    translation: V3,
}

const ORTHONORMAL_TOLERANCE: f64 = 1e-6;

impl Similarity {
    /// From a row-major 4x4 matrix.
    pub fn from_row_major(m: &[f64; 16]) -> Result<Self, String> {
        let fail = |what: &str| Err(format!("Scan proposal option scanToModel {what}"));
        if m.iter().any(|v| !v.is_finite()) {
            return fail("must be finite");
        }
        if m[12] != 0. || m[13] != 0. || m[14] != 0. || m[15] != 1. {
            return fail("must be affine (last row 0, 0, 0, 1)");
        }
        let linear = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
        let column = |c: usize| [linear[0][c], linear[1][c], linear[2][c]];
        let det = dot(column(0), cross(column(1), column(2)));
        if !(det > 0.) {
            return fail("must not reflect or collapse space");
        }
        let s = det.cbrt();
        let rotation = linear.map(|row| row.map(|v| v / s));
        for a in 0..3 {
            for b in 0..3 {
                let rc = |c: usize| [rotation[0][c], rotation[1][c], rotation[2][c]];
                let expected = if a == b { 1. } else { 0. };
                if (dot(rc(a), rc(b)) - expected).abs() > ORTHONORMAL_TOLERANCE {
                    return fail("must be a rotation with one uniform scale");
                }
            }
        }
        if [m[3], m[7], m[11]].iter().any(|v| v.abs() > 1e12) {
            return fail("translation must lie within 1e12 m");
        }
        Ok(Self { rotation, scale: s, translation: [m[3], m[7], m[11]] })
    }

    pub fn direction(&self, v: V3) -> V3 {
        self.rotation.map(|row| dot(row, v))
    }

    pub fn point(&self, p: V3) -> V3 {
        add(scale(self.direction(p), self.scale), self.translation)
    }
}

/// A detected plane in the model frame.
#[derive(Debug, Clone)]
pub(crate) struct Face {
    pub index: u32,
    pub normal: V3,
    pub centroid: V3,
    /// Counter-clockwise about `normal`.
    pub corners: [V3; 4],
    pub area: f64,
    pub rms: f64,
    pub inlier_points: u64,
    pub inlier_voxels: u32,
    /// `normal` faces the scanner: the scanned side.
    pub scanner_facing: bool,
}

impl Face {
    pub fn z_range(&self) -> (f64, f64) {
        let z = self.corners.map(|c| c[2]);
        (z.iter().copied().fold(f64::INFINITY, f64::min), z.iter().copied().fold(f64::NEG_INFINITY, f64::max))
    }
    /// Projections of the corners onto a horizontal direction.
    pub fn span_along(&self, axis: V3) -> (f64, f64) {
        let s = self.corners.map(|c| dot(c, axis));
        (s.iter().copied().fold(f64::INFINITY, f64::min), s.iter().copied().fold(f64::NEG_INFINITY, f64::max))
    }
}

/// A detected cylinder in the model frame.
#[derive(Debug, Clone)]
pub(crate) struct Tube {
    pub index: u32,
    pub start: V3,
    pub end: V3,
    /// Circumradius for a polygonal column (#6937), else the fitted radius.
    pub radius: f64,
    /// Number of faces of a polygonal column, `None` for a round surface.
    pub faces: Option<u32>,
    pub arc_degrees: f64,
    pub rms: f64,
    pub inlier_points: u64,
    pub inlier_voxels: u32,
}

impl Tube {
    /// Radius of the round profile proposed for this tube: the fitted radius,
    /// or for a regular polygon of `n` faces and circumradius `R` the circle
    /// of equal area, `R * sqrt(n sin(2 pi / n) / (2 pi))` (an octagon: 0.949 R).
    pub fn profile_radius(&self) -> f64 {
        match self.faces {
            Some(n) if n >= 3 => {
                let n = f64::from(n);
                self.radius * (n * (2. * std::f64::consts::PI / n).sin() / (2. * std::f64::consts::PI)).sqrt()
            }
            _ => self.radius,
        }
    }
    pub fn direction(&self) -> V3 {
        unit(sub(self.end, self.start))
    }
}

pub(crate) struct Detections {
    pub faces: Vec<Face>,
    pub tubes: Vec<Tube>,
}

/// Move every plane and cylinder of `report` into the model frame.
pub(crate) fn to_model(report: &ScanSegmentationReport, t: &Similarity) -> Detections {
    let faces = report
        .planes
        .iter()
        .enumerate()
        .map(|(index, p)| Face {
            index: index as u32,
            normal: unit(t.direction(p.normal)),
            centroid: t.point(p.centroid),
            corners: p.extent.corners.map(|c| t.point(c)),
            area: p.area_square_metres * t.scale * t.scale,
            rms: p.rms_metres * t.scale,
            inlier_points: p.inlier_points,
            inlier_voxels: p.inlier_voxels,
            scanner_facing: p.normal_source == NormalSource::Scanner,
        })
        .collect();
    let tubes = report
        .cylinders
        .iter()
        .enumerate()
        .map(|(index, c)| Tube {
            index: index as u32,
            start: t.point(c.axis_start),
            end: t.point(c.axis_end),
            radius: c.radius * t.scale,
            faces: c.faceted.as_ref().map(|f| f.faces),
            arc_degrees: c.arc_degrees,
            rms: c.rms_metres * t.scale,
            inlier_points: c.inlier_points,
            inlier_voxels: c.inlier_voxels,
        })
        .collect();
    Detections { faces, tubes }
}
