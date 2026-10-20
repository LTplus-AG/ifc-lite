// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! AdvancedBrep processor - NURBS/B-spline surfaces.
//!
//! Handles IfcAdvancedBrep and IfcAdvancedBrepWithVoids.
//! Delegates per-face processing to shared advanced_face module.

use crate::{Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use crate::router::GeometryProcessor;

/// AdvancedBrep processor
/// Handles IfcAdvancedBrep and IfcAdvancedBrepWithVoids - NURBS/B-spline surfaces
/// Supports planar faces and B-spline surface tessellation
pub struct AdvancedBrepProcessor;

impl AdvancedBrepProcessor {
    pub fn new() -> Self {
        Self
    }
}

impl AdvancedBrepProcessor {
    /// Mesh the Brep; `rtc_file_units` is removed from every face in f64
    /// before f32 narrowing (#5698).
    fn process_rebased(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
        rtc_file_units: Option<(f64, f64, f64)>,
    ) -> Result<Mesh> {
        super::advanced_plan::lower_brep(entity, decoder, quality, rtc_file_units)?.evaluate()
    }
}

impl GeometryProcessor for AdvancedBrepProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        Self::process_rebased(entity, decoder, quality, None)
    }

    fn process_in_rtc_frame(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
        rtc_file_units: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        Some(Self::process_rebased(entity, decoder, quality, Some(rtc_file_units)))
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcAdvancedBrep, IfcType::IfcAdvancedBrepWithVoids]
    }
}

impl Default for AdvancedBrepProcessor {
    fn default() -> Self {
        Self::new()
    }
}

/// Standalone B-spline surface processor.
///
/// Handles `IfcBSplineSurfaceWithKnots` and `IfcRationalBSplineSurfaceWithKnots`
/// when they appear directly as items inside an `IfcShapeRepresentation` (e.g.
/// a `Surface3D` rep), without being wrapped in an `IfcAdvancedFace`.
pub struct BSplineSurfaceProcessor;

impl BSplineSurfaceProcessor {
    pub fn new() -> Self {
        Self
    }

    /// Mesh the surface; `rtc_file_units` shifts the control net in f64
    /// before f32 narrowing (#5698).
    fn process_rebased(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
        rtc_file_units: Option<(f64, f64, f64)>,
    ) -> Result<Mesh> {
        super::advanced_plan::lower_bspline_surface(entity, decoder, quality, rtc_file_units)?
            .evaluate()
    }
}

impl Default for BSplineSurfaceProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryProcessor for BSplineSurfaceProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        Self::process_rebased(entity, decoder, quality, None)
    }

    fn process_in_rtc_frame(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
        rtc_file_units: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        Some(Self::process_rebased(entity, decoder, quality, Some(rtc_file_units)))
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![
            IfcType::IfcBSplineSurfaceWithKnots,
            IfcType::IfcRationalBSplineSurfaceWithKnots,
        ]
    }
}
