// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Profile Processors - Handle all IFC profile types
//!
//! Dynamic profile processing for parametric, arbitrary, and composite profiles.

use crate::profile::Profile2D;
use crate::tessellation::TessellationQuality;
use crate::{Error, Point2, Point3, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType, ProfileCategory};
use std::cell::Cell;

mod curves_2d;
mod curves_3d;
mod outline;
mod placement;
mod shapes;
mod steel_shapes;
mod simplify;
#[cfg(test)]
mod tests;

use outline::trim_polyline;
use simplify::{mirror_profile_about_y_axis, simplify_smooth_curve_polyline};

/// Maximum recursion depth for nested curve processing.
/// Prevents stack overflow from deeply nested CompositeCurve → TrimmedCurve → CompositeCurve chains.
const MAX_CURVE_DEPTH: u32 = 50;

/// One bound of an `IfcTrimmingSelect` on a trimmed conic. A `Parameter` is an
/// angle in the project's PLANEANGLEUNIT; a `Cartesian` point is resolved to an
/// angle against the conic's own placement and radii once those are known.
#[derive(Debug, Clone, Copy)]
enum TrimSelect {
    Parameter(f64),
    Cartesian(Point2<f64>),
}

/// Maximum recursion depth for nested profile definitions (DerivedProfile → parent → parent...).
/// Prevents stack overflow in WASM from Revit exports with deep profile nesting.
const MAX_PROFILE_DEPTH: u32 = 16;

/// Profile processor - processes IFC profiles into 2D contours
pub struct ProfileProcessor {
    schema: IfcSchema,
    /// Tessellation detail for the in-flight `process`/`get_curve_points` call.
    /// Set at those entry points and read by the curve/arc tessellators below,
    /// avoiding a `quality` parameter on every internal curve method. Single
    /// router instance is single-threaded (the router holds `RefCell` caches),
    /// so a `Cell` is sufficient. Defaults to [`TessellationQuality::Medium`].
    active_quality: Cell<TessellationQuality>,
}

impl ProfileProcessor {
    /// Create new profile processor
    pub fn new(schema: IfcSchema) -> Self {
        Self {
            schema,
            active_quality: Cell::new(TessellationQuality::Medium),
        }
    }

    /// Tessellation detail selected for the current call.
    #[inline]
    fn quality(&self) -> TessellationQuality {
        self.active_quality.get()
    }

    /// Set the tessellation detail for subsequent curve sampling.
    ///
    /// [`process`](Self::process) and [`get_curve_points`](Self::get_curve_points)
    /// set this themselves; call it explicitly before the lower-level samplers
    /// (`get_composite_curve_points_trimmed`, `get_polyline_points_trimmed`)
    /// that don't take a `quality` argument.
    #[inline]
    pub fn set_tessellation_quality(&self, quality: TessellationQuality) {
        self.active_quality.set(quality);
    }

    /// Process any IFC profile definition at the given tessellation `quality`.
    ///
    /// Profile-plane tessellation (the 2D outline that becomes an extruded cap
    /// or an opening cutter) never gets *finer* above `Medium` — denser opening
    /// circles only multiply the earcut cap-bridge slivers that show up as scar
    /// lines on plates with bolt holes (issue #976). Below `Medium` they do get
    /// *coarser*: circular profiles via
    /// [`TessellationQuality::circle_profile_segments`], and profile arcs/fillets
    /// (rounded rectangles, steel-section root fillets, trimmed conics,
    /// indexed-polycurve arcs) via [`TessellationQuality::profile_arc_segments`].
    /// The quality knob drives the *curved 3D surfaces* instead — swept paths (via
    /// [`get_curve_points`](Self::get_curve_points)), cylinders, surfaces of
    /// revolution, NURBS, and brep edges — where faceting is actually visible.
    #[inline]
    pub fn process(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Result<Profile2D> {
        self.active_quality.set(quality);
        self.process_with_depth(profile, decoder, 0)
    }

    /// Process profile with depth tracking to prevent stack overflow from nested profiles.
    fn process_with_depth(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Profile2D> {
        if depth > MAX_PROFILE_DEPTH {
            return Err(Error::geometry(format!(
                "Profile nesting depth {} exceeds limit {} at #{}",
                depth, MAX_PROFILE_DEPTH, profile.id
            )));
        }
        match profile.ifc_type {
            IfcType::IfcDerivedProfileDef | IfcType::IfcMirroredProfileDef => {
                self.process_derived_with_depth(profile, decoder, depth)
            }
            _ => match self.schema.profile_category(&profile.ifc_type) {
                Some(ProfileCategory::Parametric) => self.process_parametric(profile, decoder),
                Some(ProfileCategory::Arbitrary) => self.process_arbitrary(profile, decoder),
                Some(ProfileCategory::Composite) => self.process_composite_with_depth(profile, decoder, depth),
                _ => Err(Error::geometry(format!(
                    "Unsupported profile type: {}",
                    profile.ifc_type
                ))),
            },
        }
    }

    /// Process parametric profiles (rectangle, circle, I-shape, etc.)
    #[inline]
    fn process_parametric(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Profile2D> {
        // First create the base profile shape
        let mut base_profile = match profile.ifc_type {
            IfcType::IfcRectangleProfileDef => self.process_rectangle(profile),
            IfcType::IfcRoundedRectangleProfileDef => self.process_rounded_rectangle(profile),
            IfcType::IfcCircleProfileDef => self.process_circle(profile),
            IfcType::IfcCircleHollowProfileDef => self.process_circle_hollow(profile),
            IfcType::IfcRectangleHollowProfileDef => self.process_rectangle_hollow(profile),
            IfcType::IfcIShapeProfileDef => self.process_i_shape(profile),
            IfcType::IfcAsymmetricIShapeProfileDef => self.process_asymmetric_i_shape(profile),
            IfcType::IfcLShapeProfileDef => self.process_l_shape(profile),
            IfcType::IfcUShapeProfileDef => self.process_u_shape(profile),
            IfcType::IfcTShapeProfileDef => self.process_t_shape(profile),
            IfcType::IfcCShapeProfileDef => self.process_c_shape(profile),
            IfcType::IfcZShapeProfileDef => self.process_z_shape(profile),
            _ => Err(Error::geometry(format!(
                "Unsupported parametric profile: {}",
                profile.ifc_type
            ))),
        }?;

        // Parameterised profiles are defined centred on their bounding box, and the
        // Position placement below is applied relative to that centred origin.
        // Several asymmetric builders (L/U/T/C) emit their points from a corner, so
        // centre every parametric profile here in one place. Already-centred shapes
        // (rectangle, circle, I, Z, …) are unaffected.
        base_profile.center_on_bbox();

        // Apply Profile Position transform (attribute 2: IfcAxis2Placement2D)
        if let Some(pos_attr) = profile.get(2) {
            if !pos_attr.is_null() {
                if let Some(pos_entity) = decoder.resolve_ref(pos_attr)? {
                    if pos_entity.ifc_type == IfcType::IfcAxis2Placement2D {
                        self.apply_profile_position(&mut base_profile, &pos_entity, decoder)?;
                    }
                }
            }
        }

        Ok(base_profile)
    }

    /// Process IfcDerivedProfileDef / IfcMirroredProfileDef.
    ///
    /// IFC4 attributes:
    ///   0: ProfileType
    ///   1: ProfileName
    ///   2: ParentProfile (IfcProfileDef)
    ///   3: Operator      (IfcCartesianTransformationOperator2D)
    ///   4: Label
    ///
    /// `IfcMirroredProfileDef` is a subtype that **always** writes `$` for
    /// the Operator attribute — the mirror is implicit about the parent
    /// profile's local Y-axis (x → −x) per IFC4. We therefore short-circuit
    /// on the subtype and only require Operator on the bare
    /// `IfcDerivedProfileDef` form.
    fn process_derived_with_depth(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Profile2D> {
        let parent_attr = profile
            .get(2)
            .ok_or_else(|| Error::geometry("Derived profile missing ParentProfile".to_string()))?;
        let parent_profile = decoder.resolve_ref(parent_attr)?.ok_or_else(|| {
            Error::geometry("Derived profile ParentProfile not found".to_string())
        })?;

        let mut result = self.process_with_depth(&parent_profile, decoder, depth + 1)?;

        if profile.ifc_type == IfcType::IfcMirroredProfileDef {
            mirror_profile_about_y_axis(&mut result);
            return Ok(result);
        }

        // IfcDerivedProfileDef. Operator is required per the spec but some
        // authoring tools omit it when the derived profile happens to equal
        // its parent; treat null as the identity transform rather than
        // erroring (the parent already came back fully processed).
        let Some(operator_attr) = profile.get(3) else {
            return Ok(result);
        };
        if operator_attr.is_null() {
            return Ok(result);
        }
        let Some(operator) = decoder.resolve_ref(operator_attr)? else {
            return Ok(result);
        };
        self.apply_cartesian_transformation_operator_2d(&mut result, &operator, decoder)?;
        Ok(result)
    }

    /// Process arbitrary closed profile (polyline-based)
    /// IfcArbitraryClosedProfileDef: ProfileType, ProfileName, OuterCurve
    /// IfcArbitraryProfileDefWithVoids: ProfileType, ProfileName, OuterCurve, InnerCurves
    fn process_arbitrary(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Profile2D> {
        // Get outer curve (attribute 2)
        let curve_attr = profile
            .get(2)
            .ok_or_else(|| Error::geometry("Arbitrary profile missing OuterCurve".to_string()))?;

        let curve = decoder
            .resolve_ref(curve_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve OuterCurve".to_string()))?;

        // Process outer curve
        let raw_outer = self.process_curve(&curve, decoder)?;
        // Issue #635 — downsample over-tessellated smooth curves so round/
        // curved openings produce compact extrusions (a big perf win on the
        // exact kernel; historically also the deleted BSP polygon budget).
        let outer_points = simplify_smooth_curve_polyline(&raw_outer, decoder.length_unit_scale());
        let mut result = Profile2D::new(outer_points);

        // Check if this is IfcArbitraryProfileDefWithVoids (has inner curves)
        if profile.ifc_type == IfcType::IfcArbitraryProfileDefWithVoids {
            // Get inner curves list (attribute 3)
            if let Some(inner_curves_attr) = profile.get(3) {
                let inner_curves = decoder.resolve_ref_list(inner_curves_attr)?;
                for inner_curve in inner_curves {
                    let raw_hole = self.process_curve(&inner_curve, decoder)?;
                    let hole_points =
                        simplify_smooth_curve_polyline(&raw_hole, decoder.length_unit_scale());
                    result.add_hole(hole_points);
                }
            }
        }

        Ok(result)
    }

    /// Process any supported curve type into 2D points
    #[inline]
    fn process_curve(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        self.process_curve_with_depth(curve, decoder, 0)
    }

    /// Process curve with depth tracking to prevent stack overflow
    fn process_curve_with_depth(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Vec<Point2<f64>>> {
        if depth > MAX_CURVE_DEPTH {
            return Err(Error::geometry(format!(
                "Curve nesting depth {} exceeds limit {}",
                depth, MAX_CURVE_DEPTH
            )));
        }
        match curve.ifc_type {
            IfcType::IfcPolyline => self.process_polyline(curve, decoder),
            IfcType::IfcIndexedPolyCurve => self.process_indexed_polycurve(curve, decoder),
            IfcType::IfcCompositeCurve => {
                self.process_composite_curve_with_depth(curve, decoder, depth)
            }
            IfcType::IfcTrimmedCurve => {
                self.process_trimmed_curve_with_depth(curve, decoder, depth)
            }
            IfcType::IfcCircle => self.process_circle_curve(curve, decoder),
            IfcType::IfcEllipse => self.process_ellipse_curve(curve, decoder),
            // A bare IfcLine projected onto the 2D plane. Rare as a profile curve,
            // but handling it keeps trimmed-line bases (below) from erroring.
            IfcType::IfcLine => Ok(self
                .get_line_points_3d(curve, decoder, 0.0, 1.0)?
                .into_iter()
                .map(|p| Point2::new(p.x, p.y))
                .collect()),
            _ => Err(Error::geometry(format!(
                "Unsupported curve type: {}",
                curve.ifc_type
            ))),
        }
    }

    /// Get 3D points from a curve (for swept disk solid, etc.) at the given
    /// tessellation `quality`.
    #[inline]
    pub fn get_curve_points(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Result<Vec<Point3<f64>>> {
        self.active_quality.set(quality);
        self.get_curve_points_with_depth(curve, decoder, 0)
    }

    /// Get 3D curve points with depth tracking to prevent stack overflow
    fn get_curve_points_with_depth(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Vec<Point3<f64>>> {
        if depth > MAX_CURVE_DEPTH {
            return Err(Error::geometry(format!(
                "Curve nesting depth {} exceeds limit {}",
                depth, MAX_CURVE_DEPTH
            )));
        }
        match curve.ifc_type {
            IfcType::IfcPolyline => self.process_polyline_3d(curve, decoder),
            IfcType::IfcCompositeCurve => {
                self.process_composite_curve_3d_with_depth(curve, decoder, depth)
            }
            // IFC4x3 IfcGradientCurve = IfcCompositeCurve subtype that adds a
            // 2D BaseCurve (attr 2) supplying the horizontal layout + own
            // segments supplying the vertical (z) profile. The minimum-viable
            // sampler for #859's IfcLinearPlacement use case returns the
            // horizontal track of points by recursing into BaseCurve and
            // dropping Z to 0 — every signal lands at the correct (x, y)
            // station, just at the alignment's reference elevation instead
            // of the true grade-corrected z. Full grade evaluation is a
            // follow-up; "every signal pinned to its alignment station" is
            // already a vast improvement over the pre-fix "all signals at
            // world origin" state.
            IfcType::IfcGradientCurve => {
                if let Some(base_attr) = curve.get(2) {
                    if !base_attr.is_null() {
                        if let Some(base) = decoder.resolve_ref(base_attr)? {
                            return self.get_curve_points_with_depth(&base, decoder, depth + 1);
                        }
                    }
                }
                // No BaseCurve → fall through to the segments-as-composite path
                // so we at least produce something rather than erroring.
                self.process_composite_curve_3d_with_depth(curve, decoder, depth)
            }
            IfcType::IfcCircle => self.process_circle_3d(curve, decoder),
            IfcType::IfcIndexedPolyCurve => {
                // Native 3D path: handles both IfcCartesianPointList2D (z=0) and
                // IfcCartesianPointList3D, and fits arc segments in the plane of
                // their three control points. Falling through to the 2D fallback
                // would drop the Z coordinate of every 3D point list (issue #631
                // stirrup case).
                self.process_indexed_polycurve_3d(curve, decoder)
            }
            // A bare IfcLine directrix: P(u) = Pnt + u·V over the unit parameter
            // range [0, 1]. Swept-disk solids that reference an untrimmed line
            // rely on the solid's own StartParam/EndParam (applied by the swept
            // processor) for the real extent.
            IfcType::IfcLine => self.get_line_points_3d(curve, decoder, 0.0, 1.0),
            IfcType::IfcTrimmedCurve => {
                // A trimmed IfcLine has a well-defined 3D parametric form that
                // must NOT be flattened through the 2D path (z would be dropped,
                // and the basis IfcLine isn't handled there at all — issue #1164,
                // where a SweptDiskSolid rebar directrix is an IfcTrimmedCurve
                // over an IfcLine and produced an empty mesh).
                if let Some(basis_attr) = curve.get(0) {
                    if let Some(basis) = decoder.resolve_ref(basis_attr)? {
                        match basis.ifc_type {
                            IfcType::IfcLine => {
                                return self.process_trimmed_line_3d(curve, &basis, decoder);
                            }
                            // A trimmed circle/ellipse must be sampled against its
                            // own 3D placement. The 2D fallback below lifts with
                            // z=0 and drops any out-of-plane component — rebar
                            // bend arcs live in the XZ plane, so flattening them
                            // twisted the swept tube (issue #1348).
                            IfcType::IfcCircle | IfcType::IfcEllipse => {
                                return self.process_trimmed_conic_3d(curve, &basis, decoder);
                            }
                            _ => {}
                        }
                    }
                }
                // Other basis curves (splines): get 2D points and lift to 3D.
                let points_2d = self.process_trimmed_curve_with_depth(curve, decoder, depth)?;
                Ok(points_2d
                    .into_iter()
                    .map(|p| Point3::new(p.x, p.y, 0.0))
                    .collect())
            }
            _ => {
                // Fallback: try 2D curve and convert to 3D
                let points_2d = self.process_curve_with_depth(curve, decoder, depth)?;
                Ok(points_2d
                    .into_iter()
                    .map(|p| Point3::new(p.x, p.y, 0.0))
                    .collect())
            }
        }
    }

    /// Process composite curve into 3D points
    fn process_composite_curve_3d_with_depth(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Vec<Point3<f64>>> {
        // IfcCompositeCurve: Segments, SelfIntersect
        let segments_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("CompositeCurve missing Segments".to_string()))?;

        let segments = decoder.resolve_ref_list(segments_attr)?;
        let mut result = Vec::new();
        // Track the last IfcCurveSegment we sampled so we can extrapolate its
        // terminal point after the loop. Each segment in the loop body emits
        // only its START placement; without the terminal, every product whose
        // `DistanceAlong` falls inside the FINAL segment after its start
        // station gets clamped by `sample_polyline_at_distance` to that
        // segment's start (i.e. authored station 800 instead of 900 on a
        // 932-m alignment with the last segment spanning 800..932). See the
        // post-loop block below.
        let mut last_curve_segment_terminal: Option<Point3<f64>> = None;

        for segment in segments {
            // IFC4x3 IfcCurveSegment (alignment fixtures) has a different
            // attribute layout from the IFC2x3/IFC4 IfcCompositeCurveSegment
            // the original walker was written for:
            //   IfcCurveSegment: 0 Transition, 1 Placement (IfcAxis2Placement2D/3D),
            //                    2 SegmentStart (length measure), 3 SegmentLength,
            //                    4 ParentCurve
            // Without recognising it, every alignment-authored composite
            // curve errored out at "Failed to resolve ParentCurve" (the old
            // walker reading attr 2 hit the SegmentStart length measure),
            // which broke #859's IfcLinearPlacement resolver — every
            // linearly-placed signal/referent fell back to identity.
            //
            // Minimum-viable handling: emit the segment's Placement.Location
            // as ONE sample point and let the linear-placement sampler
            // interpolate linearly between segment starts. Sparse but
            // already a vast improvement over "all at origin". A full
            // alignment evaluator (sampling the ParentCurve inside each
            // segment's authored start..start+length range) is follow-up
            // scope.
            if segment.ifc_type == IfcType::IfcCurveSegment {
                if let Some(placement_attr) = segment.get(1) {
                    if !placement_attr.is_null() {
                        if let Some(placement) = decoder.resolve_ref(placement_attr)? {
                            if let Some((origin, x_axis)) =
                                axis2_placement_location_and_x_axis_3d(&placement, decoder)
                            {
                                if result.last().is_none_or(|last: &Point3<f64>| {
                                    (last - origin).norm() > 1e-9
                                }) {
                                    result.push(origin);
                                }
                                // Stash the segment's projected terminal in
                                // case this turns out to be the last segment.
                                // Read SegmentLength (attr 3); the value may
                                // be wrapped in an IfcLengthMeasure typed
                                // record or be a bare REAL.
                                let segment_length = segment
                                    .get(3)
                                    .and_then(|a| a.as_float())
                                    .unwrap_or(0.0);
                                if segment_length > 1e-9 {
                                    last_curve_segment_terminal =
                                        Some(origin + x_axis * segment_length);
                                } else {
                                    last_curve_segment_terminal = None;
                                }
                                continue;
                            }
                        }
                    }
                }
                // Couldn't read this segment's placement — skip rather than fail.
                last_curve_segment_terminal = None;
                continue;
            }
            // Non-IfcCurveSegment branch (IfcCompositeCurveSegment): the
            // explicit ParentCurve samples below already give us the segment
            // end, so clear the stashed terminal.
            last_curve_segment_terminal = None;

            // IfcCompositeCurveSegment: Transition, SameSense, ParentCurve
            let parent_curve_attr = segment.get(2).ok_or_else(|| {
                Error::geometry("CompositeCurveSegment missing ParentCurve".to_string())
            })?;

            let parent_curve = decoder
                .resolve_ref(parent_curve_attr)?
                .ok_or_else(|| Error::geometry("Failed to resolve ParentCurve".to_string()))?;

            // Get same_sense for direction
            let same_sense = segment
                .get(1)
                .and_then(|v| match v {
                    ifc_lite_core::AttributeValue::Enum(e) => Some(e.as_str()),
                    _ => None,
                })
                .map(|e| e == "T" || e == "TRUE")
                .unwrap_or(true);

            let mut segment_points =
                self.get_curve_points_with_depth(&parent_curve, decoder, depth + 1)?;

            if !same_sense {
                segment_points.reverse();
            }

            // Skip first point if we already have points (avoid duplicates)
            if !result.is_empty() && !segment_points.is_empty() {
                result.extend(segment_points.into_iter().skip(1));
            } else {
                result.extend(segment_points);
            }
        }

        // Append the last IfcCurveSegment's terminal sample (exact for
        // straight segments, tangent approximation for curves). Pre-fix the
        // missing terminal made `sample_polyline_at_distance` clamp any
        // product in the final segment to the segment's start station; this
        // surfaces visibly as railway signals authored at station 900 m
        // snapping onto the segment-start marker around station 800 m.
        if let Some(terminal) = last_curve_segment_terminal {
            if result.last().is_none_or(|last: &Point3<f64>| {
                (last - terminal).norm() > 1e-9
            }) {
                result.push(terminal);
            }
        }

        Ok(result)
    }

    /// Process composite curve into 3D points, honoring `IfcSweptDiskSolid`'s
    /// `StartParam`/`EndParam`. Per IFC, a composite curve is parameterised so
    /// segment `i` covers `[i, i+1]`. Segments fully outside `[start, end]` are
    /// dropped; boundary segments are truncated by linearly interpolating along
    /// their sampled point list (a per-segment normalised parameter).
    ///
    /// Non-conformant out-of-range `EndParam` values (notably Revit, which
    /// emits a cumulative-per-segment parameter that can exceed `num_segments`)
    /// are clamped to the upper bound of the spec domain — this matches the
    /// authoring tool's effective intent (render the whole curve) without
    /// guessing at a length-unit interpretation that proved wrong on real
    /// files (see #631 follow-up notes).
    pub fn get_composite_curve_points_trimmed(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        start_param: Option<f64>,
        end_param: Option<f64>,
    ) -> Result<Vec<Point3<f64>>> {
        let segments_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("CompositeCurve missing Segments".to_string()))?;
        let segments = decoder.resolve_ref_list(segments_attr)?;
        let num_segments = segments.len();
        if num_segments == 0 {
            return Ok(Vec::new());
        }

        let start = start_param.unwrap_or(0.0).max(0.0);
        let end = end_param.unwrap_or(num_segments as f64).min(num_segments as f64);
        if end <= start {
            return Ok(Vec::new());
        }

        let mut result: Vec<Point3<f64>> = Vec::new();
        for (idx, segment) in segments.into_iter().enumerate() {
            let seg_start = idx as f64;
            let seg_end = seg_start + 1.0;
            // Skip segments fully outside the trim window
            if seg_end <= start || seg_start >= end {
                continue;
            }

            let parent_curve_attr = segment.get(2).ok_or_else(|| {
                Error::geometry("CompositeCurveSegment missing ParentCurve".to_string())
            })?;
            let parent_curve = decoder
                .resolve_ref(parent_curve_attr)?
                .ok_or_else(|| Error::geometry("Failed to resolve ParentCurve".to_string()))?;
            let same_sense = segment
                .get(1)
                .and_then(|v| match v {
                    ifc_lite_core::AttributeValue::Enum(e) => Some(e.as_str()),
                    _ => None,
                })
                .map(|e| e == "T" || e == "TRUE")
                .unwrap_or(true);

            let mut seg_points = self.get_curve_points_with_depth(&parent_curve, decoder, 1)?;
            if !same_sense {
                seg_points.reverse();
            }
            if seg_points.len() < 2 {
                continue;
            }

            // Map global trim window to this segment's local [0,1] domain
            let local_start = (start - seg_start).clamp(0.0, 1.0);
            let local_end = (end - seg_start).clamp(0.0, 1.0);
            if local_end <= local_start {
                continue;
            }

            let trimmed = if local_start == 0.0 && local_end == 1.0 {
                seg_points
            } else {
                trim_polyline(&seg_points, local_start, local_end)
            };

            if trimmed.is_empty() {
                continue;
            }
            // Drop the first point of the next segment ONLY when it coincides with
            // the last point already in `result` — i.e. the segments share their
            // junction vertex and concatenating verbatim would duplicate it.
            // Composite curves whose adjacent segments are not coordinate-identical
            // at the boundary (e.g. floating-point drift, or segments stitched
            // together at deliberately distinct points) must keep the first vertex
            // or the directrix gets distorted.
            const JUNCTION_EPS: f64 = 1e-6;
            let mut iter = trimmed.into_iter();
            if let Some(first) = iter.next() {
                let coincident = result.last().is_some_and(|last| {
                    (first.x - last.x).abs() < JUNCTION_EPS
                        && (first.y - last.y).abs() < JUNCTION_EPS
                        && (first.z - last.z).abs() < JUNCTION_EPS
                });
                if !coincident {
                    result.push(first);
                }
                result.extend(iter);
            }
        }

        Ok(result)
    }

    /// Process trimmed curve
    /// IfcTrimmedCurve: BasisCurve, Trim1, Trim2, SenseAgreement, MasterRepresentation
    fn process_trimmed_curve_with_depth(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Vec<Point2<f64>>> {
        // Get basis curve (attribute 0)
        let basis_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("TrimmedCurve missing BasisCurve".to_string()))?;

        let basis_curve = decoder
            .resolve_ref(basis_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve BasisCurve".to_string()))?;

        // MasterRepresentation (attribute 4) selects which trim flavour wins when
        // both an IfcParameterValue and an IfcCartesianPoint are supplied for the
        // same Trim*. `.CARTESIAN.` means resolve the bounds from the points;
        // anything else (`.PARAMETER.`, `.UNSPECIFIED.`, or missing) keeps the
        // parameter-first behaviour. Either way `extract_trim_select` falls back
        // to whichever flavour is actually present.
        let prefer_cartesian = curve
            .get(4)
            .and_then(|v| v.as_enum())
            .map(|m| m == "CARTESIAN")
            .unwrap_or(false);

        // Get trim parameters
        let trim1 = curve
            .get(1)
            .and_then(|v| self.extract_trim_select(v, prefer_cartesian, decoder));
        let trim2 = curve
            .get(2)
            .and_then(|v| self.extract_trim_select(v, prefer_cartesian, decoder));

        // Get sense agreement (attribute 3) - default true
        let sense = curve
            .get(3)
            .and_then(|v| match v {
                ifc_lite_core::AttributeValue::Enum(s) => Some(s == "T"),
                _ => None,
            })
            .unwrap_or(true);

        // Process basis curve based on type
        match basis_curve.ifc_type {
            IfcType::IfcCircle | IfcType::IfcEllipse => {
                self.process_trimmed_conic(&basis_curve, trim1, trim2, sense, decoder)
            }
            IfcType::IfcLine => {
                // Apply the trim parametrically in 3D, then project to 2D. The
                // generic fallback would call process_curve_with_depth on the raw
                // line and silently drop Trim1/Trim2 (the unit-length segment).
                Ok(self
                    .process_trimmed_line_3d(curve, &basis_curve, decoder)?
                    .into_iter()
                    .map(|p| Point2::new(p.x, p.y))
                    .collect())
            }
            _ => {
                // Fallback: try to process as a regular curve (with depth tracking)
                self.process_curve_with_depth(&basis_curve, decoder, depth + 1)
            }
        }
    }

    /// Process composite curve into 2D points
    /// IfcCompositeCurve: Segments (list of IfcCompositeCurveSegment), SelfIntersect
    fn process_composite_curve_with_depth(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Vec<Point2<f64>>> {
        // Get segments list (attribute 0)
        let segments_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("CompositeCurve missing Segments".to_string()))?;

        let segments = decoder.resolve_ref_list(segments_attr)?;

        let mut all_points = Vec::new();

        for segment in segments {
            // IfcCompositeCurveSegment: Transition, SameSense, ParentCurve
            if segment.ifc_type != IfcType::IfcCompositeCurveSegment {
                continue;
            }

            // Get ParentCurve (attribute 2)
            let parent_curve_attr = segment.get(2).ok_or_else(|| {
                Error::geometry("CompositeCurveSegment missing ParentCurve".to_string())
            })?;

            let parent_curve = decoder
                .resolve_ref(parent_curve_attr)?
                .ok_or_else(|| Error::geometry("Failed to resolve ParentCurve".to_string()))?;

            // Get SameSense (attribute 1) - whether to reverse the curve
            // Note: IFC enum values like ".T." are parsed/stored as "T" without dots
            let same_sense = segment
                .get(1)
                .and_then(|v| match v {
                    ifc_lite_core::AttributeValue::Enum(s) => Some(s == "T" || s == "TRUE"),
                    _ => None,
                })
                .unwrap_or(true);

            // Process the parent curve (with depth tracking)
            let mut segment_points =
                self.process_curve_with_depth(&parent_curve, decoder, depth + 1)?;

            if !same_sense {
                segment_points.reverse();
            }

            // Append to result, avoiding duplicates at connection points
            for pt in segment_points {
                if all_points.last() != Some(&pt) {
                    all_points.push(pt);
                }
            }
        }

        Ok(all_points)
    }

    /// Process composite profile (combination of profiles)
    /// IfcCompositeProfileDef: ProfileType, ProfileName, Profiles, Label
    fn process_composite_with_depth(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Profile2D> {
        // Get profiles list (attribute 2)
        let profiles_attr = profile
            .get(2)
            .ok_or_else(|| Error::geometry("Composite profile missing Profiles".to_string()))?;

        let sub_profiles = decoder.resolve_ref_list(profiles_attr)?;

        if sub_profiles.is_empty() {
            return Err(Error::geometry(
                "Composite profile has no sub-profiles".to_string(),
            ));
        }

        // Process first profile as base
        let mut result = self.process_with_depth(&sub_profiles[0], decoder, depth + 1)?;

        // Add remaining profiles as holes (simplified - assumes they're holes)
        for sub_profile in &sub_profiles[1..] {
            let hole = self.process_with_depth(sub_profile, decoder, depth + 1)?;
            result.add_hole(hole.outer);
        }

        Ok(result)
    }
}

/// Resolve an `IfcAxis2Placement2D` or `IfcAxis2Placement3D` into its
/// origin point AND local X-axis (RefDirection) as a unit vector. Used to
/// extrapolate the last `IfcCurveSegment`'s terminal point:
/// `origin + x_axis * SegmentLength` is exact for straight segments and a
/// tangent approximation for arcs / clothoids — both strictly better than
/// dropping the terminal sample entirely, which caused
/// `sample_polyline_at_distance` to clamp any product whose
/// `DistanceAlong` fell inside the final segment to its start station.
///
/// IFC4x3 attribute layout:
///   IfcAxis2Placement2D: 0 Location, 1 RefDirection
///   IfcAxis2Placement3D: 0 Location, 1 Axis (local Z), 2 RefDirection (local X)
///
/// Returns `(origin, x_axis)` with `x_axis` defaulting to +X when the
/// RefDirection is absent or zero-length (matches the EXPRESS default).
fn axis2_placement_location_and_x_axis_3d(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<(Point3<f64>, nalgebra::Vector3<f64>)> {
    let is_3d = placement.ifc_type == IfcType::IfcAxis2Placement3D;
    let is_2d = placement.ifc_type == IfcType::IfcAxis2Placement2D;
    if !is_2d && !is_3d {
        return None;
    }
    let location_attr = placement.get(0)?;
    if location_attr.is_null() {
        return None;
    }
    let location = decoder.resolve_ref(location_attr).ok().flatten()?;
    if location.ifc_type != IfcType::IfcCartesianPoint {
        return None;
    }
    let coords = location.get(0)?.as_list()?;
    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
    let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
    let origin = Point3::new(x, y, z);

    // RefDirection slot: index 2 on 3D, index 1 on 2D.
    let ref_dir_idx = if is_3d { 2 } else { 1 };
    let mut x_axis = nalgebra::Vector3::x();
    if let Some(dir_attr) = placement.get(ref_dir_idx) {
        if !dir_attr.is_null() {
            if let Some(dir) = decoder.resolve_ref(dir_attr).ok().flatten() {
                if dir.ifc_type == IfcType::IfcDirection {
                    if let Some(ratios) = dir.get(0).and_then(|a| a.as_list()) {
                        let dx = ratios.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                        let dy = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                        let dz = ratios.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                        let v = nalgebra::Vector3::new(dx, dy, dz);
                        if v.norm() > 1e-12 {
                            x_axis = v.normalize();
                        }
                    }
                }
            }
        }
    }
    Some((origin, x_axis))
}
