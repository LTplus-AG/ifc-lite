// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! SurfaceOfLinearExtrusion processor - surface sweep geometry.

use crate::{Error, Mesh, Point2, Point3, Result, TessellationQuality};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

use super::helpers::get_axis2_placement_transform_by_id;
use crate::router::GeometryProcessor;

#[path = "surface_plan.rs"]
pub(crate) mod plan;

/// SurfaceOfLinearExtrusion processor
/// Handles IfcSurfaceOfLinearExtrusion - surface created by sweeping a curve along a direction
pub struct SurfaceOfLinearExtrusionProcessor;

#[path = "curve_walk.rs"]
mod curve_walk;
use curve_walk::{CurveWalk, SEAM_EPS};
#[cfg(test)]
use curve_walk::MAX_CURVE_NODES;

impl SurfaceOfLinearExtrusionProcessor {
    pub fn new() -> Self {
        Self
    }

    pub(crate) fn lower(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        rtc_file_units: Option<(f64, f64, f64)>) -> Result<plan::LinearExtrusionSurfacePlan> {
        plan::lower(entity, decoder, rtc_file_units)
    }
}

impl GeometryProcessor for SurfaceOfLinearExtrusionProcessor {
    fn lower_owned(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        _quality: TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>)
        -> Option<Result<crate::program::OwnedConstructor>> {
        use crate::program::constructor::Constructor;
        Some(self.lower(entity, decoder, rtc_file_units).map(|plan| crate::program::OwnedConstructor::new(Constructor::LinearExtrusionSurface(plan))))
    }

    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        _quality: TessellationQuality,
    ) -> Result<Mesh> {
        Self::process_rebased(entity, decoder, None)
    }

    /// Rebase by `rtc_file_units` in f64, after Position and before the f32
    /// narrowing, as every raw-coordinate processor does (#7688, the RTC half
    /// of #7678 PROC-S23).
    fn process_in_rtc_frame(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        _quality: TessellationQuality,
        rtc_file_units: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        Some(Self::process_rebased(entity, decoder, Some(rtc_file_units)))
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcSurfaceOfLinearExtrusion]
    }
}

impl SurfaceOfLinearExtrusionProcessor {
    /// The first swept vertex (file units, the item's own frame): Position
    /// applied to the first curve point. The router's raw-coordinate RTC
    /// probe reads it, so a national-grid surface is rebased before narrowing.
    pub(crate) fn first_vertex(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        let curve_id = entity.get(slot::IfcSurfaceOfLinearExtrusion::SWEPT_CURVE.index())?.as_entity_ref()?;
        let position = Self::position_transform(entity, decoder).ok()?;
        let first = *Self::get_profile_curve_points(curve_id, decoder).ok()?.first()?;
        let p = position.transform_point(&Point3::new(first.x, first.y, 0.0));
        Some((p.x, p.y, p.z))
    }

    fn position_transform(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        match entity.get(slot::IfcSurfaceOfLinearExtrusion::POSITION.index()).and_then(|attr| attr.as_entity_ref()) {
            Some(pos_id) => get_axis2_placement_transform_by_id(pos_id, decoder),
            None => Ok(Matrix4::identity()),
        }
    }

    fn process_rebased(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        rtc_file_units: Option<(f64, f64, f64)>,
    ) -> Result<Mesh> {
        Ok(Self::new().lower(entity, decoder, rtc_file_units)?.evaluate())
    }

    /// Extract curve points from a profile definition
    /// Longest nested-curve chain the profile sampler will follow. See
    /// `curve_points_guarded` for why this sits alongside the visited set.
    const MAX_CURVE_NESTING_DEPTH: u32 = 32;

    fn get_profile_curve_points(
        profile_id: u32,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        let mut walk = CurveWalk::new();
        Self::profile_curve_points_guarded(profile_id, decoder, &mut walk)
    }

    fn profile_curve_points_guarded(
        profile_id: u32,
        decoder: &mut EntityDecoder,
        walk: &mut CurveWalk,
    ) -> Result<Vec<Point2<f64>>> {
        let profile = decoder.decode_by_id(profile_id)?;

        // IfcArbitraryOpenProfileDef: 0=ProfileType, 1=ProfileName, 2=Curve
        // IfcArbitraryClosedProfileDef: 0=ProfileType, 1=ProfileName, 2=OuterCurve
        let curve_attr = profile
            .get(2)
            .ok_or_else(|| Error::geometry("Profile missing curve".to_string()))?;

        let curve_id = curve_attr
            .as_entity_ref()
            .ok_or_else(|| Error::geometry("Expected entity reference for curve".to_string()))?;

        Self::curve_points_guarded(curve_id, decoder, 0, walk)
    }

    /// Sample a CURVE (not a profile) into 2D points.
    ///
    /// Split out of `get_profile_curve_points` because
    /// `extract_composite_curve_points` was calling that function with a
    /// segment's `ParentCurve` id — a curve where a profile was expected. It
    /// read attribute 2 of the curve as "the profile's curve", and an
    /// `IfcPolyline` has no attribute 2, so every composite-curve profile
    /// errored on each segment, had the error swallowed by the caller's
    /// `if let Ok(..)`, and returned `Ok(vec![])`. Silently: no points, no
    /// error, indistinguishable from a legitimately empty profile.
    ///
    /// Guarded by BOTH a visited set and a depth cap, because they bound
    /// different things. The set stops cycles and fan-out --
    /// `extract_composite_curve_points` loops over segments, so `k` segments
    /// each leading back cost `O(k^depth)` and a cap alone would trade the
    /// abort for a hang. The cap stops a long ACYCLIC chain, where every
    /// insert succeeds, the set never fires, and the recursion aborts on stack
    /// depth alone (Codex, #2871/#2872 review). Neither substitutes for the
    /// other (#2866).
    fn curve_points_guarded(
        curve_id: u32,
        decoder: &mut EntityDecoder,
        depth: u32,
        walk: &mut CurveWalk,
    ) -> Result<Vec<Point2<f64>>> {
        // Refused, not `Ok(empty)`: the composite caller accumulates, so an
        // empty cycle or depth-capped branch was a silently SHORTER curve
        // (#7688). Both still terminate; they now say so.
        if depth >= Self::MAX_CURVE_NESTING_DEPTH {
            return Err(Error::geometry(format!(
                "Curve nesting exceeds {} at #{curve_id}",
                Self::MAX_CURVE_NESTING_DEPTH
            )));
        }
        if !walk.seen.insert(curve_id) {
            return Err(Error::geometry(format!("Cyclic curve reference at #{curve_id}")));
        }
        walk.spend()?;
        let out = Self::curve_points_inner(curve_id, decoder, depth, walk);
        // PATH-scoped: removed on the way out. A global set would be a memo
        // that returns the WRONG value -- it hands back an empty vec rather
        // than the points it computed the first time -- and the caller
        // ACCUMULATES, so a ParentCurve legitimately reused by two segments
        // would contribute once and silently shorten the profile.
        walk.seen.remove(&curve_id);
        out
    }

    fn curve_points_inner(
        curve_id: u32,
        decoder: &mut EntityDecoder,
        depth: u32,
        walk: &mut CurveWalk,
    ) -> Result<Vec<Point2<f64>>> {

        // Get curve entity to determine type
        let curve = decoder.decode_by_id(curve_id)?;

        match curve.ifc_type {
            IfcType::IfcPolyline => {
                // IfcPolyline: attribute 0 is Points (list of IfcCartesianPoint)
                let point_ids = decoder
                    .get_polyloop_point_ids_fast(curve_id)
                    .ok_or_else(|| Error::geometry("Failed to get polyline points".to_string()))?;

                // A point that does not resolve refuses the whole curve, never
                // the one corner: a polyline one vertex short is a different
                // outline, meshed as if it were the authored one. Same rule as
                // `helpers::extract_loop_points_by_id`.
                let mut points = Vec::with_capacity(point_ids.len());
                for point_id in point_ids {
                    let (x, y, z) = decoder.get_cartesian_point_fast(point_id).ok_or_else(|| {
                        Error::geometry(format!("Polyline point #{point_id} did not resolve"))
                    })?;
                    // The swept curve is a 2D profile curve. A point off its
                    // plane is refused, never flattened into a different
                    // curve (#7688 review).
                    if z != 0.0 {
                        return Err(Error::geometry(format!(
                            "Polyline point #{point_id} lies off the profile plane (z = {z})"
                        )));
                    }
                    points.push(Point2::new(x, y));
                }
                Ok(points)
            }
            IfcType::IfcCompositeCurve => {
                // Handle composite curves by extracting segments
                Self::extract_composite_curve_points(curve_id, decoder, depth, walk)
            }
            // Any other curve is refused, never read as raw bytes: the old
            // fallback took the first nested list as points, which is a
            // B-spline's control polygon or a trimmed curve's Trim1 (#7688,
            // PROC-S1). Refused, the item stays visibly unmeshed, as it was
            // while this processor was not registered.
            other => Err(Error::geometry(format!(
                "SurfaceOfLinearExtrusion SweptCurve: unsupported curve {other}"
            ))),
        }
    }

    /// Extract points from a composite curve
    fn extract_composite_curve_points(
        curve_id: u32,
        decoder: &mut EntityDecoder,
        depth: u32,
        walk: &mut CurveWalk,
    ) -> Result<Vec<Point2<f64>>> {
        let curve = decoder.decode_by_id(curve_id)?;

        // IfcCompositeCurve: attribute 0 is Segments (list of IfcCompositeCurveSegment)
        let segments_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("CompositeCurve missing Segments".to_string()))?;

        let segment_refs = segments_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected segment list".to_string()))?;

        let mut all_points: Vec<Point2<f64>> = Vec::new();

        for seg_ref in segment_refs {
            let seg_id = seg_ref.as_entity_ref().ok_or_else(|| {
                Error::geometry("Expected entity reference for segment".to_string())
            })?;

            let segment = decoder.decode_by_id(seg_id)?;

            // IfcCompositeCurveSegment: 0=Transition, 1=SameSense, 2=ParentCurve
            let parent_curve_attr = segment
                .get(2)
                .ok_or_else(|| Error::geometry("Segment missing ParentCurve".to_string()))?;

            let parent_curve_id = parent_curve_attr.as_entity_ref().ok_or_else(|| {
                Error::geometry("Expected entity reference for parent curve".to_string())
            })?;

            // IfcCompositeCurveSegment.SameSense (attribute 1): when false the
            // segment traverses its ParentCurve BACKWARDS. Nothing applied it
            // before because no segment ever produced points to orient -- the
            // dispatch bug above meant every one came back empty, so a
            // reversed segment and a forward one were indistinguishable.
            let same_sense = segment.get_bool(1).unwrap_or(true);

            // The ParentCurve is a CURVE, not a profile. Routing it through the
            // profile entry point read its attribute 2 as "the curve" and
            // dropped every segment (#2866). A segment that does not read
            // refuses the curve: skipping it meshed a SHORTER curve as if it
            // were the authored one (#7688, the rule of #3421).
            let mut segment_points =
                Self::curve_points_guarded(parent_curve_id, decoder, depth + 1, walk)?;
            if !same_sense {
                segment_points.reverse();
            }
            // Drop the seam point only when it ACTUALLY duplicates the
            // previous segment's end. A `.DISCONTINUOUS.` transition, or a
            // gap from a malformed file, leaves a real point that an
            // unconditional skip would eat.
            let drop_seam = match (all_points.last(), segment_points.first()) {
                (Some(prev), Some(next)) => {
                    (prev.x - next.x).abs() < SEAM_EPS && (prev.y - next.y).abs() < SEAM_EPS
                }
                _ => false,
            };
            all_points.extend(segment_points.into_iter().skip(usize::from(drop_seam)));
        }

        Ok(all_points)
    }
}

impl Default for SurfaceOfLinearExtrusionProcessor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "surface_cycle_tests.rs"]
mod surface_cycle_tests;
