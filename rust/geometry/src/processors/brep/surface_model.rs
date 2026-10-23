// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{Mesh, Point3, Result, TessellationQuality};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use super::super::advanced_face::note_face_refused;
use super::super::helpers::read_loop_points_by_id;
use crate::router::GeometryProcessor;
pub(crate) use super::surface_model_plan::SurfaceModelPlan;

/// A dropped `IfcAdvancedFace` (unsupported surface, or a #4901 degree/work
/// cap) has nowhere else to go here — neither processor has a
/// `GeometryRouter` for `record_unsupported_item`. This trace is the honest
/// floor. `allow`: `diag_debug!` no-ops without a tracing subscriber (wasm
/// release), leaving both params unused there.
#[allow(unused_variables)]
pub(super) fn trace_capped_face(face_id: u32, error: &dyn std::fmt::Display) {
    crate::diag::diag_debug!(
        { face_id, error = %error, "skipping unsupported advanced face in surface model" }
        else {
            #[cfg(debug_assertions)]
            eprintln!("[ifc-lite] Skipping unsupported advanced face #{face_id} in surface model: {error}");
        }
    );
}

/// The bounds of a simple (`IfcPolyLoop`) face, or `None` when a bound does
/// not read: that refuses the face (D14, under D3), as in
/// `FacetedBrepProcessor`, and the refusal is counted here.
pub(super) fn read_simple_face_bounds(
    face_type: &IfcType,
    bound_ids: Vec<u32>,
    decoder: &mut EntityDecoder,
) -> Option<(Option<Vec<Point3<f64>>>, Vec<Vec<Point3<f64>>>)> {
    let bound_count = bound_ids.len();
    let mut degenerate = 0usize;
    let mut outer_points: Option<Vec<Point3<f64>>> = None;
    let mut hole_points: Vec<Vec<Point3<f64>>> = Vec::new();

    for bound_id in bound_ids {
        // (loop_id, orientation, is_outer) straight from raw bytes
        let (loop_id, orientation, is_outer) = match decoder.get_face_bound_fast(bound_id) {
            Some(data) => data,
            None => continue,
        };

        let mut points = match read_loop_points_by_id(loop_id, decoder) {
            Some(p) => p,
            None => continue,
        };
        // Readable but under three points: degenerate, skipped.
        if points.len() < 3 {
            degenerate += 1;
            continue;
        }

        if !orientation {
            points.reverse();
        }

        if is_outer || outer_points.is_none() {
            // A second outer bound demotes the previous one to a
            // hole rather than dropping it (parity with
            // FacetedBrepProcessor); a face is otherwise lost.
            if outer_points.is_some() && is_outer {
                if let Some(prev_outer) = outer_points.take() {
                    hole_points.push(prev_outer);
                }
            }
            outer_points = Some(points);
        } else {
            hole_points.push(points);
        }
    }

    // A bound that does not read refuses the face (D14, under
    // D3), as in `FacetedBrepProcessor`.
    let read = hole_points.len() + usize::from(outer_points.is_some()) + degenerate;
    if read < bound_count {
        note_face_refused(face_type);
        return None;
    }

    Some((outer_points, hole_points))
}

// ---------- FaceBasedSurfaceModelProcessor ----------

/// Handles `IfcFaceBasedSurfaceModel`: FbsmFaces (SET of IfcConnectedFaceSet)
/// -> Face[] -> FaceBound -> PolyLoop, or AdvancedFace[] -> FaceSurface.
pub struct FaceBasedSurfaceModelProcessor;

impl FaceBasedSurfaceModelProcessor {
    const NAMES: (&'static str, &'static str) =
        ("FaceBasedSurfaceModel missing FbsmFaces", "face set");

    pub fn new() -> Self {
        Self
    }

    pub(crate) fn lower(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
        rtc_file_units: Option<(f64, f64, f64)>,
    ) -> Result<SurfaceModelPlan> {
        super::surface_model_plan::lower(
            entity,
            decoder,
            quality,
            rtc_file_units,
            Self::NAMES,
            slot::IfcFaceBasedSurfaceModel::FBSM_FACES.index(),
        )
    }
}

impl GeometryProcessor for FaceBasedSurfaceModelProcessor {
    fn lower_owned(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        quality: crate::TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>)
        -> Option<crate::Result<crate::program::OwnedConstructor>> {
        use crate::program::constructor::Constructor;
        Some(self.lower(entity, decoder, quality, rtc_file_units).map(|plan| crate::program::OwnedConstructor::new(Constructor::SurfaceModel(plan))))
    }

    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        self.lower(entity, decoder, quality, None)?.evaluate()
    }

    fn process_in_rtc_frame(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
        rtc_file_units: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        Some(
            self.lower(entity, decoder, quality, Some(rtc_file_units))
                .and_then(SurfaceModelPlan::evaluate),
        )
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcFaceBasedSurfaceModel]
    }
}

impl Default for FaceBasedSurfaceModelProcessor {
    fn default() -> Self {
        Self::new()
    }
}

// ---------- ShellBasedSurfaceModelProcessor ----------

/// Handles `IfcShellBasedSurfaceModel`: SbsmBoundary (SET of IfcOpenShell /
/// IfcClosedShell) -> Face[] -> FaceBound -> PolyLoop, or AdvancedFace[] ->
/// FaceSurface.
pub struct ShellBasedSurfaceModelProcessor;

impl ShellBasedSurfaceModelProcessor {
    const NAMES: (&'static str, &'static str) =
        ("ShellBasedSurfaceModel missing SbsmBoundary", "shell");

    pub fn new() -> Self {
        Self
    }

    pub(crate) fn lower(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
        rtc_file_units: Option<(f64, f64, f64)>,
    ) -> Result<SurfaceModelPlan> {
        super::surface_model_plan::lower(
            entity,
            decoder,
            quality,
            rtc_file_units,
            Self::NAMES,
            slot::IfcShellBasedSurfaceModel::SBSM_BOUNDARY.index(),
        )
    }
}

impl GeometryProcessor for ShellBasedSurfaceModelProcessor {
    fn lower_owned(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        quality: crate::TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>)
        -> Option<crate::Result<crate::program::OwnedConstructor>> {
        use crate::program::constructor::Constructor;
        Some(self.lower(entity, decoder, quality, rtc_file_units).map(|plan| crate::program::OwnedConstructor::new(Constructor::SurfaceModel(plan))))
    }

    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        self.lower(entity, decoder, quality, None)?.evaluate()
    }

    fn process_in_rtc_frame(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
        rtc_file_units: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        Some(
            self.lower(entity, decoder, quality, Some(rtc_file_units))
                .and_then(SurfaceModelPlan::evaluate),
        )
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcShellBasedSurfaceModel]
    }
}

impl Default for ShellBasedSurfaceModelProcessor {
    fn default() -> Self {
        Self::new()
    }
}
