// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{Mesh, Point3, Result, TessellationQuality};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use super::super::advanced_face::note_face_refused;
use super::super::helpers::{read_loop_points_memo, PointMemo};
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
#[cfg(test)]
pub(super) fn read_simple_face_bounds(
    face_type: &IfcType,
    bound_ids: Vec<u32>,
    decoder: &mut EntityDecoder,
) -> Option<(Option<Vec<Point3<f64>>>, Vec<Vec<Point3<f64>>>)> {
    read_simple_face_bounds_memo(face_type, bound_ids, decoder, &mut PointMemo::default())
}

/// [`read_simple_face_bounds`] reusing the caller's walk-scoped [`PointMemo`].
pub(super) fn read_simple_face_bounds_memo(
    face_type: &IfcType,
    bound_ids: Vec<u32>,
    decoder: &mut EntityDecoder,
    memo: &mut PointMemo,
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

        let mut points = match read_loop_points_memo(loop_id, decoder, memo) {
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

/// The memo's own equivalence test names `read_simple_face_bounds_memo`, so
/// it lives here and reverts with it. The work it removes (repeated point reads)
/// is observed from `processors/tests.rs` through a test-only read probe.
#[cfg(test)]
mod point_memo_tests {
    use super::*;
    use crate::processors::take_face_refused;

    /// A walk-scoped point memo is invisible: reading faces that share points
    /// through one memo gives the same bounds, the same face refusals and the same
    /// refused-record count as reading each face with fresh state, including when
    /// a shared point is one the byte fast path cannot read (never memoized, so
    /// `point3` refuses it again on every use, as before).
    #[test]
    fn shared_point_memo_matches_fresh_reads_and_refusals() {
        for bad in ["IFCCARTESIANPOINT((1.,1.,1.E400))", "IFCDIRECTION((1.,1.,0.))", "IFCCARTESIANPOINT ( ( 2. , 2. ) )"] {
            let source = format!("#1=IFCCARTESIANPOINT((0.,0.));#2=IFCCARTESIANPOINT((4.,0.));#3=IFCCARTESIANPOINT((4.,4.));#4={bad};#5=IFCPOLYLOOP((#1,#2,#3));#6=IFCFACEOUTERBOUND(#5,.T.);#7=IFCPOLYLOOP((#1,#3,#4));#8=IFCFACEOUTERBOUND(#7,.T.);#9=IFCPOLYLOOP((#2,#3,#1));#10=IFCFACEOUTERBOUND(#9,.F.);");
            let faces: [Vec<u32>; 5] = [vec![6], vec![8], vec![10], vec![8], vec![6, 10]];
            let mut shared = EntityDecoder::new(&source);
            let mut memo = PointMemo::default();
            for bounds in &faces {
                let mut fresh = EntityDecoder::new(&source);
                let _ = take_face_refused();
                let want = read_simple_face_bounds(&IfcType::IfcFace, bounds.clone(), &mut fresh);
                let want_refused = take_face_refused();
                let got = read_simple_face_bounds_memo(&IfcType::IfcFace, bounds.clone(), &mut shared, &mut memo);
                assert_eq!(got, want, "{bad} {bounds:?}");
                assert_eq!(take_face_refused(), want_refused, "{bad} {bounds:?}");
            }
            let mut sequential = EntityDecoder::new(&source);
            for bounds in &faces {
                let _ = read_simple_face_bounds(&IfcType::IfcFace, bounds.clone(), &mut sequential);
            }
            let _ = take_face_refused();
            assert_eq!(shared.refused_records(), sequential.refused_records(), "{bad}");
            // Only a fast-path read is ever memoized: the spaced record is one.
            assert_eq!(memo.contains_key(&4), bad.starts_with("IFCCARTESIANPOINT ("), "{bad}");
        }
    }

    /// Independent review (#9643): points read for a loop that is then
    /// REJECTED (a later point does not read) must not stay in the memo. 100
    /// disjoint loops of 100 valid corners plus one shared invalid point used
    /// to leave 10,000 entries behind for a collection that meshes nothing.
    #[test]
    fn rejected_loops_leave_nothing_in_the_point_memo() {
        let mut source = String::from("#999999=IFCDIRECTION((1.,2.,3.));");
        let mut loops = Vec::new();
        for l in 0..100u32 {
            let mut refs = Vec::new();
            for p in 0..100u32 {
                let id = 1 + l * 100 + p;
                source.push_str(&format!("#{id}=IFCCARTESIANPOINT(({p}.,{l}.,0.));"));
                refs.push(format!("#{id}"));
            }
            refs.push("#999999".into());
            let loop_id = 500_000 + l;
            source.push_str(&format!("#{loop_id}=IFCPOLYLOOP(({}));", refs.join(",")));
            loops.push(loop_id);
        }
        let mut shared = EntityDecoder::new(&source);
        let mut fresh = EntityDecoder::new(&source);
        let mut memo = PointMemo::default();
        for id in loops {
            assert!(read_loop_points_memo(id, &mut shared, &mut memo).is_none());
            assert!(crate::processors::helpers::read_loop_points_by_id(id, &mut fresh).is_none());
        }
        assert_eq!(shared.refused_records(), fresh.refused_records());
        assert_eq!(memo.len(), 0, "a rejected loop's points stay resident");
    }

    /// The memo is bounded per lowering whatever the face set's size: past
    /// 65,536 distinct points new points are read uncached (never refused), and
    /// the coordinates are those of fresh reads.
    #[test]
    fn the_point_memo_is_bounded_and_overflow_reads_stay_exact() {
        let count = 65_536 + 300;
        let mut source = String::new();
        let mut refs = Vec::with_capacity(count);
        for id in 1..=count as u32 {
            source.push_str(&format!("#{id}=IFCCARTESIANPOINT(({id}.5,-{id}.25,0.));"));
            refs.push(format!("#{id}"));
        }
        source.push_str(&format!("#900000=IFCPOLYLOOP(({}));", refs.join(",")));
        let mut shared = EntityDecoder::new(&source);
        let mut fresh = EntityDecoder::new(&source);
        let mut memo = PointMemo::default();
        for _ in 0..2 {
            let got = read_loop_points_memo(900_000, &mut shared, &mut memo).unwrap();
            let want = crate::processors::helpers::read_loop_points_by_id(900_000, &mut fresh).unwrap();
            assert_eq!(got, want);
            assert!(memo.len() <= 65_536, "memo grew to {}", memo.len());
        }
    }
}

#[cfg(test)]
#[path = "polyloop_leaf_tests.rs"]
mod leaf_tests;
