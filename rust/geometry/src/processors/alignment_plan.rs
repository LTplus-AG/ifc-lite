// SPDX-License-Identifier: MPL-2.0
//! Owned f64 ribbon samples before the production mesh builder.
//! Sampling retains file length units and the original fixed ribbon width;
//! router unit scaling, product placement and RTC remain separate.
use super::{MAX_SAMPLES, RIBBON_HALF_WIDTH_FILE_UNITS, SAMPLE_STEP_FILE_UNITS};
use crate::{alignment::AlignmentCurve, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::{Point3, Vector3};

#[derive(Debug, Clone)]
pub(crate) enum AlignmentPlan {
    Empty,
    Ribbon {
        left_pts: Vec<Point3<f64>>,
        right_pts: Vec<Point3<f64>>,
    },
}

pub(super) fn lower(entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<AlignmentPlan> {
    // The Axis curve attribute index depends on the IFC version. Try
    // the IFC4X1 layout (attribute 7) first, then a small fallback
    // window — any IfcRef that resolves to a curve we can parse via
    // AlignmentCurve::parse wins.
    let curve = crate::alignment_axis::locate_axis_curve(entity, decoder).ok_or_else(|| {
        crate::Error::geometry(
            "IfcAlignment missing recognisable Axis curve (expected IfcAlignmentCurve or IfcPolyline)"
                .to_string(),
        )
    })?;

    let alignment = match AlignmentCurve::parse(&curve, decoder)? {
        Some(a) => a,
        None => return Ok(AlignmentPlan::Empty),
    };

    let length = alignment.horizontal_length();
    if !(length.is_finite() && length > 0.0) {
        return Ok(AlignmentPlan::Empty);
    }

    // Adaptive sample step: prefer the 1-file-unit default, but fall
    // back to a length-proportional step when that would exceed
    // MAX_SAMPLES keeps sampling bounded in sub-metre file units.
    let raw_count = ((length / SAMPLE_STEP_FILE_UNITS).ceil() as usize).max(1);
    let (sample_step, sample_count) = if raw_count > MAX_SAMPLES {
        (length / MAX_SAMPLES as f64, MAX_SAMPLES + 1)
    } else {
        (SAMPLE_STEP_FILE_UNITS, raw_count + 1)
    };
    let mut left_pts: Vec<Point3<f64>> = Vec::with_capacity(sample_count);
    let mut right_pts: Vec<Point3<f64>> = Vec::with_capacity(sample_count);

    for i in 0..sample_count {
        let station = (i as f64 * sample_step).min(length);
        let frame = alignment.evaluate(station);
        let offset = frame.right * RIBBON_HALF_WIDTH_FILE_UNITS;
        left_pts.push(frame.origin - offset);
        right_pts.push(frame.origin + offset);
    }

    Ok(AlignmentPlan::Ribbon {
        left_pts,
        right_pts,
    })
}

impl AlignmentPlan {
    pub(crate) fn evaluate(&self) -> Mesh {
        let Self::Ribbon {
            left_pts,
            right_pts,
        } = self
        else {
            return Mesh::new();
        };
        let n = left_pts.len();
        let mut mesh = Mesh::with_capacity(n * 2, (n - 1) * 6);

        // Pack vertices: alternating left/right for cache-friendly triangle
        // indexing — pair (2i, 2i+1) is the cross-section at sample i.
        let up = Vector3::new(0.0, 0.0, 1.0);
        for i in 0..n {
            mesh.add_vertex(left_pts[i], up);
            mesh.add_vertex(right_pts[i], up);
        }

        for i in 0..(n - 1) {
            let a = (i * 2) as u32; // left @ i
            let b = a + 1; // right @ i
            let c = a + 2; // left @ i+1
            let d = a + 3; // right @ i+1
                           // Two triangles per quad, CCW when viewed from +Z.
            mesh.add_triangle(a, b, d);
            mesh.add_triangle(a, d, c);
        }

        mesh
    }
}

#[cfg(test)]
#[path = "alignment_plan_tests.rs"]
mod tests;
