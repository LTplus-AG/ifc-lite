// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Swept-solid directrix sampling that honours a solid's `StartParam` /
//! `EndParam` (`IfcSweptDiskSolid`, `IfcSurfaceCurveSweptAreaSolid`). One home,
//! so the two solids cannot read the same parameters differently (#5566).

use super::outline::trim_polyline;
use super::ProfileProcessor;
use crate::tessellation::TessellationQuality;
use crate::{Error, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use std::f64::consts::TAU;

/// Relative parameter tolerance when mapping a trim window onto one segment.
const PARAM_EPS: f64 = 1e-9;

impl ProfileProcessor {
    /// Sample a swept solid's directrix in 3D over the solid's
    /// `[StartParam, EndParam]`, in the directrix's own IFC parametrisation:
    ///   - `IfcCompositeCurve`: the running sum of each segment's parameter
    ///     span (see [`Self::get_composite_curve_points_trimmed`]).
    ///   - `IfcPolyline`: point index, `[0, N-1]`.
    ///   - `IfcLine`: `P(u) = Pnt + u·V`.
    ///   - `IfcCircle` / `IfcEllipse`: angle in the project's plane-angle unit.
    ///
    /// Any other directrix (an `IfcTrimmedCurve` carries its own Trim1/Trim2,
    /// so a redundant solid-level range is a no-op; a spline's knot-based
    /// parameter is not supported) is sampled whole.
    pub fn get_directrix_points(
        &self,
        directrix: &DecodedEntity,
        decoder: &mut EntityDecoder,
        start_param: Option<f64>,
        end_param: Option<f64>,
        quality: TessellationQuality,
    ) -> Result<Vec<Point3<f64>>> {
        self.set_tessellation_quality(quality);
        if start_param.is_none() && end_param.is_none() {
            return self.get_curve_points(directrix, decoder, quality);
        }
        if directrix.ifc_type.is_subtype_of(IfcType::IfcCompositeCurve) {
            return self
                .get_composite_curve_points_trimmed(directrix, decoder, start_param, end_param);
        }
        match directrix.ifc_type {
            IfcType::IfcPolyline => {
                self.get_polyline_points_trimmed(directrix, decoder, start_param, end_param)
            }
            // Without this the line samples over its unit range [0,1] only and
            // the swept extent collapses to the (tool-emitted) vector magnitude.
            IfcType::IfcLine => self.get_line_points_3d(
                directrix,
                decoder,
                start_param.unwrap_or(0.0),
                end_param.unwrap_or(1.0),
            ),
            IfcType::IfcCircle | IfcType::IfcEllipse => {
                self.get_conic_points_trimmed(directrix, decoder, start_param, end_param)
            }
            _ => self.get_curve_points(directrix, decoder, quality),
        }
    }

    /// Sample a bare `IfcCircle` / `IfcEllipse` directrix over the angular
    /// range `[start, end]` (plane-angle units; `start` defaults to 0, `end`
    /// to one full turn). A range whose end precedes its start wraps forward
    /// through the 0/360° seam; a range longer than one turn is one turn.
    fn get_conic_points_trimmed(
        &self,
        conic: &DecodedEntity,
        decoder: &mut EntityDecoder,
        start_param: Option<f64>,
        end_param: Option<f64>,
    ) -> Result<Vec<Point3<f64>>> {
        let radius = conic
            .get_float(1)
            .ok_or_else(|| Error::geometry("Conic missing radius".to_string()))?;
        let radius2 = if conic.ifc_type == IfcType::IfcEllipse {
            conic.get_float(2).unwrap_or(radius)
        } else {
            radius
        };
        let frame = self.read_conic_placement_3d(conic, decoder)?;
        let scale = decoder.plane_angle_to_radians();
        let start = start_param.map_or(0.0, |s| s * scale);
        let mut end = end_param.map_or(start + TAU, |e| e * scale);
        if end < start {
            end += TAU;
        }
        end = end.min(start + TAU);
        if !(start.is_finite() && end.is_finite()) || end <= start {
            return Ok(Vec::new());
        }
        Ok(self.sample_conic_arc_3d(frame, (radius, radius2), start, end, decoder))
    }

    /// Process composite curve into 3D points, honoring a swept solid's
    /// `StartParam`/`EndParam`. Per ISO 10303-42 a composite curve's parameter
    /// is the running sum of its segments' parameter spans, each span that of
    /// the segment's `ParentCurve` ([`crate::analytic`] reads it: `N - 1` for a
    /// polyline, the trimmed length in `IfcVector` units for a trimmed line,
    /// the swept angle in plane-angle units for a trimmed circle). A Tekla
    /// U-bar's `EndParam` is exactly that sum; reading each segment as a unit
    /// interval instead swept the wrong extent for any partial range (#5566).
    ///
    /// Segments fully outside `[start, end]` are dropped; boundary segments are
    /// truncated by linearly interpolating along their sampled point list, which
    /// is exact in each supported parent's parameter (a polyline is sampled at
    /// its vertices, an arc uniformly in angle). An out-of-range bound clamps
    /// to the curve's domain. When any segment's parametrisation is unsupported
    /// the composite has no well-defined parameter and is sampled whole.
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
        if segments.is_empty() {
            return Ok(Vec::new());
        }

        let mut parts = Vec::with_capacity(segments.len());
        let mut spans_known = true;
        for segment in segments {
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
            // The analytic reader is stricter than the sampler (it rejects,
            // e.g., a negative radius the sampler still draws). A parent it
            // cannot read has no known span; it must not fail the solid.
            let span = crate::analytic::composite_parent_parameter_span(&parent_curve, decoder)
                .ok()
                .flatten();
            spans_known &= span.is_some();
            parts.push((parent_curve, same_sense, span.unwrap_or(0.0)));
        }

        let (start, end) = if spans_known {
            let total: f64 = parts.iter().map(|(_, _, span)| span).sum();
            (
                start_param.unwrap_or(0.0).max(0.0),
                end_param.unwrap_or(total).min(total),
            )
        } else {
            for part in &mut parts {
                part.2 = 1.0;
            }
            (0.0, parts.len() as f64)
        };
        if end <= start {
            return Ok(Vec::new());
        }

        let mut result: Vec<Point3<f64>> = Vec::new();
        let mut seg_start = 0.0;
        for (parent_curve, same_sense, span) in parts {
            let seg_end = seg_start + span;
            let window = (start - seg_start, end - seg_start);
            seg_start = seg_end;
            // Skip degenerate segments and those fully outside the trim window
            if span <= 0.0 || window.1 <= 0.0 || window.0 >= span {
                continue;
            }

            let mut seg_points = self.get_curve_points_with_depth(&parent_curve, decoder, 1)?;
            if !same_sense {
                seg_points.reverse();
            }
            if seg_points.len() < 2 {
                continue;
            }

            // Map the global trim window to this segment's local [0,1] domain.
            // A bound within parameter round-off of a segment end IS that end:
            // the running sum of spans need not reproduce an authored total
            // bit-for-bit, and a whole segment must stay its untouched samples.
            let snap = |t: f64| {
                if t <= PARAM_EPS {
                    0.0
                } else if t >= 1.0 - PARAM_EPS {
                    1.0
                } else {
                    t
                }
            };
            let local_start = snap(window.0 / span);
            let local_end = snap(window.1 / span);
            if local_end <= local_start {
                continue;
            }

            let trimmed = if local_start == 0.0 && local_end == 1.0 {
                seg_points
            } else {
                trim_polyline(&seg_points, local_start, local_end)
            };

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

    /// Sample a conic arc from `start_angle` to `end_angle` (radians in the
    /// conic's local frame; `end < start` runs clockwise). Segment count uses
    /// the same angular floor + chord-deviation budget as the 2D conic sampler
    /// so density matches across the codebase.
    pub(super) fn sample_conic_arc_3d(
        &self,
        (center, x_axis, y_axis): (Point3<f64>, Vector3<f64>, Vector3<f64>),
        (radius, radius2): (f64, f64),
        start_angle: f64,
        end_angle: f64,
        decoder: &mut EntityDecoder,
    ) -> Vec<Point3<f64>> {
        let arc_angle = (end_angle - start_angle).abs();
        let by_angle = (arc_angle / std::f64::consts::FRAC_PI_2 * 8.0).ceil() as usize;
        let by_chord = {
            const CHORD_TOL_M: f64 = 5.0e-4; // 0.5 mm absolute deviation budget
            let r_eff = radius.abs().max(radius2.abs());
            let radius_m = r_eff * decoder.length_unit_scale();
            if radius_m > CHORD_TOL_M {
                let rel = (CHORD_TOL_M / radius_m).clamp(1e-9, 0.5);
                let max_step = 2.0 * (1.0 - rel).acos();
                if max_step > 1e-9 {
                    (arc_angle / max_step).ceil() as usize
                } else {
                    0
                }
            } else {
                0
            }
        };
        let num_segments = self
            .quality()
            .profile_arc_segments(by_angle.max(by_chord), 2)
            .min(128);

        let mut points = Vec::with_capacity(num_segments + 1);
        for i in 0..=num_segments {
            let t = i as f64 / num_segments as f64;
            let angle = start_angle + t * (end_angle - start_angle);
            let p = center
                + x_axis * (radius * angle.cos())
                + y_axis * (radius2 * angle.sin());
            points.push(p);
        }
        points
    }
}
