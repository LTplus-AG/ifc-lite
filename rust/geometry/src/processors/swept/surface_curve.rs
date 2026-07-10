// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcSurfaceCurveSweptAreaSolid` / `IfcFixedReferenceSweptAreaSolid` — a 2D
//! `SweptArea` profile swept along a `Directrix` curve.

use crate::{
    profile::Profile2D, profiles::ProfileProcessor, Error, Mesh, Point3, Result,
    TessellationQuality, Vector3,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

use super::super::helpers::parse_axis2_placement_3d;
use super::disk::build_tube_rmf;
use crate::router::GeometryProcessor;

/// Processor for `IfcSurfaceCurveSweptAreaSolid` and `IfcFixedReferenceSweptAreaSolid`.
///
/// Sweeps the inherited `SweptArea` profile along the `Directrix` curve, then
/// applies the solid's `Position`. This is the representation Revit emits for
/// round HVAC duct elbows: an `IfcCircleProfileDef` swept along a trimmed
/// circular-arc directrix. Before this processor existed the elbows produced no
/// geometry at all because the router had no handler for the type — every
/// duct-elbow body was silently dropped (issue #1485).
///
/// The cross-section is oriented along the sweep with a rotation-minimising
/// frame (RMF), identical to `IfcSweptDiskSolid`. For a circular profile the RMF
/// is orientation-independent, so the swept tube is geometrically exact. For a
/// planar directrix (every duct elbow) the RMF also keeps a non-circular
/// section's out-of-plane axis stable, matching the natural placement. The exact
/// reference-surface / fixed-reference roll of a *non-circular* section swept
/// along a *non-planar* directrix is not modelled (no such case is known in the
/// wild); the shape is still produced, only its roll about the tangent may
/// differ. Both entity types share the attribute layout for slots 0..=4 and only
/// differ in slot 5 (a reference surface vs. a fixed direction), which this RMF
/// path does not consult, so one processor handles both.
pub struct SurfaceCurveSweptAreaSolidProcessor {
    profile_processor: ProfileProcessor,
}

impl SurfaceCurveSweptAreaSolidProcessor {
    pub fn new(schema: IfcSchema) -> Self {
        Self {
            profile_processor: ProfileProcessor::new(schema),
        }
    }
}

impl GeometryProcessor for SurfaceCurveSweptAreaSolidProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        // Shared IfcSweptAreaSolid attributes plus the swept-curve extension:
        //   0: SweptArea  (IfcProfileDef)         - 2D section in xy of Position
        //   1: Position   (IfcAxis2Placement3D)   - places the whole solid (opt.)
        //   2: Directrix  (IfcCurve)              - path swept along
        //   3: StartParam (IfcParameterValue)     - optional
        //   4: EndParam   (IfcParameterValue)     - optional
        //   5: ReferenceSurface / FixedReference  - orientation (see type docs)

        // --- SweptArea -> Profile2D ------------------------------------------------
        let profile_attr = entity.get(0).ok_or_else(|| {
            Error::geometry("SurfaceCurveSweptAreaSolid missing SweptArea".to_string())
        })?;
        let profile_entity = decoder
            .resolve_ref(profile_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve SweptArea".to_string()))?;
        self.profile_processor.set_tessellation_quality(quality);
        let profile = self
            .profile_processor
            .process(&profile_entity, decoder, quality)?;
        if profile.outer.len() < 3 {
            return Ok(Mesh::new());
        }

        // --- Directrix -> 3D sample points -----------------------------------------
        let directrix_attr = entity.get(2).ok_or_else(|| {
            Error::geometry("SurfaceCurveSweptAreaSolid missing Directrix".to_string())
        })?;
        let directrix = decoder
            .resolve_ref(directrix_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Directrix".to_string()))?;

        let start_param = entity.get_float(3);
        let end_param = entity.get_float(4);
        let has_trim = start_param.is_some() || end_param.is_some();

        // Mirror IfcSweptDiskSolid's directrix sampling so composite / polyline /
        // line directrixes honour the solid-level Start/EndParam. A trimmed conic
        // (the duct-elbow case) carries its own Trim1/Trim2, so get_curve_points
        // already returns just the swept arc and the redundant solid params are a
        // no-op.
        let curve_points =
            if has_trim && directrix.ifc_type.is_subtype_of(IfcType::IfcCompositeCurve) {
                self.profile_processor.get_composite_curve_points_trimmed(
                    &directrix,
                    decoder,
                    start_param,
                    end_param,
                )?
            } else if has_trim && directrix.ifc_type == IfcType::IfcPolyline {
                self.profile_processor.get_polyline_points_trimmed(
                    &directrix,
                    decoder,
                    start_param,
                    end_param,
                )?
            } else if has_trim && directrix.ifc_type == IfcType::IfcLine {
                self.profile_processor.get_line_points_3d(
                    &directrix,
                    decoder,
                    start_param.unwrap_or(0.0),
                    end_param.unwrap_or(1.0),
                )?
            } else {
                self.profile_processor
                    .get_curve_points(&directrix, decoder, quality)?
            };

        // Drop consecutive coincident samples — a zero-length step yields a NaN
        // tangent in the RMF and shatters the tube.
        let mut points: Vec<Point3<f64>> = Vec::with_capacity(curve_points.len());
        for p in curve_points {
            if points
                .last()
                .is_none_or(|last: &Point3<f64>| (p - *last).norm() > 1e-9)
            {
                points.push(p);
            }
        }
        if points.len() < 2 {
            return Ok(Mesh::new());
        }

        // --- Position: place the whole solid ---------------------------------------
        let position: Matrix4<f64> = match entity.get(1) {
            Some(pos_attr) if !pos_attr.is_null() => match decoder.resolve_ref(pos_attr)? {
                Some(pos_entity) => parse_axis2_placement_3d(&pos_entity, decoder)?,
                None => Matrix4::identity(),
            },
            _ => Matrix4::identity(),
        };
        for p in &mut points {
            *p = position.transform_point(p);
        }

        // --- Sweep the profile along the placed directrix --------------------------
        let (_, perp1s, perp2s) = build_tube_rmf(&points);
        sweep_profile_along_frames(&profile, &points, &perp1s, &perp2s)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![
            IfcType::IfcSurfaceCurveSweptAreaSolid,
            IfcType::IfcFixedReferenceSweptAreaSolid,
        ]
    }
}

impl Default for SurfaceCurveSweptAreaSolidProcessor {
    fn default() -> Self {
        Self::new(IfcSchema::new())
    }
}

/// Sweep a 2D `profile` (outer boundary + holes) along the directrix samples
/// `points`, placing the section into each per-sample frame `(perp1, perp2)`.
/// Emits side walls for every loop plus triangulated end caps, then computes
/// smooth per-vertex normals in the directrix-local frame (small coordinates,
/// precise) exactly like `IfcSweptDiskSolid`.
///
/// Vertex layout is one contiguous "ring" per directrix sample, each ring
/// ordered as `outer` points then every hole's points — the same order
/// `Profile2D::triangulate` emits, so the cap triangle indices address ring
/// slots directly.
fn sweep_profile_along_frames(
    profile: &Profile2D,
    points: &[Point3<f64>],
    perp1s: &[Vector3<f64>],
    perp2s: &[Vector3<f64>],
) -> Result<Mesh> {
    let n = points.len();
    if n < 2 || perp1s.len() != n || perp2s.len() != n {
        return Ok(Mesh::new());
    }

    // Loop slices in triangulation order: outer first, then each hole.
    let loops: Vec<&[nalgebra::Point2<f64>]> = std::iter::once(profile.outer.as_slice())
        .chain(profile.holes.iter().map(|h| h.as_slice()))
        .collect();
    let ring_len: usize = loops.iter().map(|l| l.len()).sum();
    if ring_len < 3 {
        return Ok(Mesh::new());
    }

    let mut mesh = Mesh::with_capacity(n * ring_len, 0);

    // Ring vertices, sample by sample. Placeholder normals are overwritten by
    // calculate_normals below.
    let placeholder = Vector3::new(0.0, 0.0, 1.0);
    for i in 0..n {
        let p = points[i];
        let u = perp1s[i];
        let v = perp2s[i];
        for loop_pts in &loops {
            for pt in loop_pts.iter() {
                mesh.add_vertex(p + u * pt.x + v * pt.y, placeholder);
            }
        }
    }

    // Side walls: connect ring i to ring i+1 for each loop, wrapping the loop.
    // `calculate_normals` uses (v1-v0)x(v2-v0); with a CCW outer loop the winding
    // below yields +perp1 (radially outward) face normals. A CW hole loop flips
    // the sign so its wall normal faces into the void.
    for i in 0..n - 1 {
        let base_i = (i * ring_len) as u32;
        let base_next = ((i + 1) * ring_len) as u32;
        let mut loop_start = 0u32;
        for loop_pts in &loops {
            let m = loop_pts.len() as u32;
            if m >= 2 {
                for j in 0..m {
                    let jn = (j + 1) % m;
                    let a = base_i + loop_start + j;
                    let b = base_i + loop_start + jn;
                    let c = base_next + loop_start + j;
                    let d = base_next + loop_start + jn;
                    mesh.add_triangle(a, d, c);
                    mesh.add_triangle(a, b, d);
                }
            }
            loop_start += m;
        }
    }

    // End caps from the profile triangulation (handles holes). The start cap
    // faces -tangent (reversed winding), the end cap faces +tangent.
    if let Ok(tri) = profile.triangulate() {
        let base_first = 0u32;
        let base_last = ((n - 1) * ring_len) as u32;
        for t in tri.indices.chunks_exact(3) {
            let (i0, i1, i2) = (t[0] as u32, t[1] as u32, t[2] as u32);
            mesh.add_triangle(base_first + i0, base_first + i2, base_first + i1);
            mesh.add_triangle(base_last + i0, base_last + i1, base_last + i2);
        }
    }

    crate::calculate_normals(&mut mesh);
    Ok(mesh)
}
