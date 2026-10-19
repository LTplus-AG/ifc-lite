// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{Mesh, Point3, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use super::super::helpers::{push_rebased, FaceData, FaceResult};
use super::faceted_plan;
use crate::router::GeometryProcessor;

// ---------- FacetedBrepProcessor ----------

/// FacetedBrep processor
/// Handles IfcFacetedBrep - explicit mesh with faces
/// Supports faces with inner bounds (holes)
/// Uses parallel triangulation for large BREPs
pub struct FacetedBrepProcessor;

impl FacetedBrepProcessor {
    pub fn new() -> Self {
        Self
    }

    /// Triangulate a single face (can be called in parallel)
    /// Optimized with fast paths for simple faces.
    ///
    /// `rtc`: RTC offset subtracted from f64 coordinates BEFORE f32 conversion.
    /// For infrastructure models with world-space coordinates (e.g. Y ≈ 6.2M),
    /// f32 only has ~0.5m precision. Subtracting RTC in f64 first brings
    /// values near origin where f32 has sub-mm precision, eliminating jitter.
    #[inline]
    pub(super) fn triangulate_face(face: &FaceData, rtc: (f64, f64, f64)) -> FaceResult {
        use crate::triangulation::{
            calculate_polygon_normal, quad_split_3d, triangulate_planar_face,
        };
        let n = face.outer_points.len();
        let mut positions = Vec::with_capacity(n * 3);

        // FAST PATH: triangle, or convex polygon of up to 8 corners, without
        // holes: a fan, no triangulation needed. A quad takes the interior
        // diagonal (a concave quad's `0-2` split lies outside the ring,
        // #7686 GEOM-3 / PROC-S10).
        if face.hole_points.is_empty() && (3..=8).contains(&n) {
            let fan =
                |n: usize| -> Vec<u32> { (1..n as u32 - 1).flat_map(|i| [0, i, i + 1]).collect() };
            let indices = match n {
                3 => Some(vec![0, 1, 2]),
                4 => Some(quad_split_3d(&face.outer_points).to_vec()),
                _ => Self::is_convex_3d(
                    &face.outer_points,
                    &calculate_polygon_normal(&face.outer_points),
                )
                .then(|| fan(n)),
            };
            if let Some(indices) = indices {
                push_rebased(&mut positions, &face.outer_points, rtc);
                return FaceResult {
                    positions,
                    indices,
                    refused: false,
                };
            }
        }

        // SLOW PATH: complex polygon or polygon with holes. A failed holed
        // triangulation refuses the face; it is never filled over its
        // authored openings (#7686 PROC-S5).
        let Ok(indices) = triangulate_planar_face(&face.outer_points, &face.hole_points) else {
            return FaceResult {
                positions: Vec::new(),
                indices: Vec::new(),
                refused: true,
            };
        };
        let all_points = face
            .outer_points
            .iter()
            .chain(face.hole_points.iter().flatten());
        push_rebased(&mut positions, all_points, rtc);
        FaceResult {
            positions,
            indices,
            refused: false,
        }
    }

    /// Whether every corner of the ring turns the same way about `normal`.
    #[inline]
    fn is_convex_3d(ring: &[Point3<f64>], normal: &nalgebra::Vector3<f64>) -> bool {
        let n = ring.len();
        let mut sign = 0i8;
        for i in 0..n {
            let (p0, p1, p2) = (&ring[i], &ring[(i + 1) % n], &ring[(i + 2) % n]);
            let dot = (p1 - p0).cross(&(p2 - p1)).dot(normal);
            if dot.abs() > 1e-10 {
                let current_sign = if dot > 0.0 { 1i8 } else { -1i8 };
                if sign == 0 {
                    sign = current_sign;
                } else if sign != current_sign {
                    return false;
                }
            }
        }
        true
    }
}

impl FacetedBrepProcessor {
    /// Mesh the Brep. With `rtc_file_units`, the offset is subtracted from the
    /// f64 loop coordinates during f32 conversion, preserving sub-centimetre
    /// detail at national-grid magnitudes (e.g. Y ≈ 6.2M metres).
    fn process_rebased(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        rtc_file_units: Option<(f64, f64, f64)>,
    ) -> Result<Mesh> {
        Ok(faceted_plan::lower(entity, decoder, rtc_file_units)?.evaluate())
    }
}

impl FacetedBrepProcessor {
    /// Mesh the Brep rebased by `rtc` (file units) before f32 narrowing; the
    /// same work as [`GeometryProcessor::process_in_rtc_frame`].
    pub fn process_with_rtc(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        rtc: (f64, f64, f64),
    ) -> Result<Mesh> {
        self.process_rebased(entity, decoder, Some(rtc))
    }
}

impl GeometryProcessor for FacetedBrepProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        _quality: TessellationQuality,
    ) -> Result<Mesh> {
        self.process_rebased(entity, decoder, None)
    }

    fn process_in_rtc_frame(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        _quality: TessellationQuality,
        rtc_file_units: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        Some(self.process_with_rtc(entity, decoder, schema, rtc_file_units))
    }

    /// `IfcFacetedBrepWithVoids` shares attribute 0 (Outer); its inner Voids
    /// shells are not rendered, as for `IfcAdvancedBrepWithVoids` (#7688).
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcFacetedBrep, IfcType::IfcFacetedBrepWithVoids]
    }
}

impl Default for FacetedBrepProcessor {
    fn default() -> Self {
        Self::new()
    }
}
