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

use crate::router::GeometryProcessor;
use crate::{Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

#[path = "alignment_plan.rs"]
pub(crate) mod plan;

/// IfcAlignment processor — emits a ribbon polyline mesh.
pub struct IfcAlignmentProcessor;

impl IfcAlignmentProcessor {
    pub fn new() -> Self {
        Self
    }

    pub(crate) fn lower(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<plan::AlignmentPlan> {
        plan::lower(entity, decoder)
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
    fn lower_owned(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        _quality: crate::TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>)
        -> Option<crate::Result<crate::program::OwnedConstructor>> {
        use crate::program::constructor::Constructor;
        if rtc_file_units.is_some() { return None; }
        Some(self.lower(entity, decoder).map(|plan| crate::program::OwnedConstructor::new(Constructor::Alignment(plan))))
    }

    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        _quality: TessellationQuality,
    ) -> Result<Mesh> {
        Ok(self.lower(entity, decoder)?.evaluate())
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcAlignment]
    }
}
