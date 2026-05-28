// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IfcAlignment processor — renders an alignment's directrix curve as a
//! thin triangulated ribbon so it shows up in the 3D viewer.
//!
//! The actual curve evaluation lives in [`crate::alignment::AlignmentCurve`]
//! (used today by the sectioned-solid processor). Here we just take the
//! Axis curve referenced by `IfcAlignment` (or any other entity that
//! `AlignmentCurve::parse` understands), sample it at a fixed station
//! interval, and emit a flat ribbon two triangles wide per segment along
//! the alignment's "right" direction.

use crate::alignment::AlignmentCurve;
use crate::router::GeometryProcessor;
use crate::{Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::{Point3, Vector3};
use std::sync::OnceLock;

fn t_alignment_curve() -> IfcType {
    // IfcAlignmentCurve is an IFC4X1-only entity; the codegen targets
    // IFC4X3 so it's not in the enum. Resolve by name and cache.
    static T: OnceLock<IfcType> = OnceLock::new();
    *T.get_or_init(|| IfcType::from_str("IFCALIGNMENTCURVE"))
}

/// IfcAlignment processor — emits a ribbon polyline mesh.
pub struct IfcAlignmentProcessor;

impl IfcAlignmentProcessor {
    pub fn new() -> Self {
        Self
    }
}

impl Default for IfcAlignmentProcessor {
    fn default() -> Self {
        Self::new()
    }
}

/// Station spacing for ribbon sampling, in file length units. The
/// alignment evaluator returns extrapolated points past either end, so we
/// stop at exactly the horizontal length to avoid drawing trailing
/// segments past the authored curve.
///
/// Assumes the file unit ≈ 1 metre. For non-metre files (millimetre
/// authoring is common on infrastructure models) a 1 km alignment in
/// mm would emit 1,000,001 samples and OOM/hang the geometry pass
/// (PR #849 chatgpt-codex P1 review). [`MAX_SAMPLES`] caps the count
/// and falls back to a coarser, length-proportional step when this
/// constant would generate too many — robust against any unit choice
/// without needing a routing/unit-scale plumbing change.
const SAMPLE_STEP_FILE_UNITS: f64 = 1.0;
/// Hard cap on samples per alignment — prevents pathological
/// unit/length combinations from exploding the mesh. A 5 km alignment
/// at 1 m steps is well under this; mm-unit files trigger the
/// length-proportional fallback step below.
const MAX_SAMPLES: usize = 5_000;
/// Width of the rendered ribbon (along the alignment's right-of-travel),
/// also in file length units. 0.5 m at the alignment's authored scale —
/// thin enough to read as a curve but wide enough to survive distant
/// camera angles.
const RIBBON_HALF_WIDTH_FILE_UNITS: f64 = 0.25;

impl GeometryProcessor for IfcAlignmentProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
    ) -> Result<Mesh> {
        // The Axis curve attribute index depends on the IFC version. Try
        // the IFC4X1 layout (attribute 7) first, then a small fallback
        // window — any IfcRef that resolves to a curve we can parse via
        // AlignmentCurve::parse wins.
        let curve = locate_axis_curve(entity, decoder)?;

        let alignment = match AlignmentCurve::parse(&curve, decoder)? {
            Some(a) => a,
            None => return Ok(Mesh::new()),
        };

        let length = alignment.horizontal_length();
        if !(length.is_finite() && length > 0.0) {
            return Ok(Mesh::new());
        }

        // Adaptive sample step: prefer the 1-file-unit default, but fall
        // back to a length-proportional step when that would exceed
        // [`MAX_SAMPLES`] (the case for sub-metre file units on long
        // alignments — issue raised in PR #849 review).
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

        Ok(mesh)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcAlignment]
    }
}

/// Resolve the alignment's directrix curve. Tries each plausible attribute
/// index in turn — IFC4X1 puts Axis at 7, some IFC4X3 publishers reuse
/// Representation (6), and a few experimental variants hang it at 8.
fn locate_axis_curve(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<DecodedEntity> {
    for idx in [7usize, 8, 6] {
        let Some(attr) = entity.get(idx) else { continue };
        if attr.is_null() {
            continue;
        }
        let Some(resolved) = decoder.resolve_ref(attr)? else {
            continue;
        };
        if resolved.ifc_type == t_alignment_curve()
            || resolved.ifc_type == IfcType::IfcPolyline
        {
            return Ok(resolved);
        }
    }
    Err(crate::Error::geometry(
        "IfcAlignment missing recognisable Axis curve (expected IfcAlignmentCurve or IfcPolyline)"
            .to_string(),
    ))
}
