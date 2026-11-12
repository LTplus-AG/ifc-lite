// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC4x3 `IfcGradientCurve` as a swept solid's directrix: the plan of its
//! `BaseCurve` with the elevation of its vertical profile, evaluated by the
//! same [`AlignmentCurve`] that `IfcSectionedSolidHorizontal` and
//! `IfcLinearPlacement` use (#5327). Before this, the sweep followed the flat
//! `BaseCurve` (z = 0), and a trimmed gradient directrix was read as a plain
//! composite curve and refused.

use crate::profiles::ProfileProcessor;
use crate::alignment::AlignmentCurve;
use crate::alignment_arc_length::ArcLengthMap;
use crate::math::tol::CHORD_TOL_M;
use crate::tessellation::TessellationQuality;
use crate::{Point3, Result, Vector3};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

/// Splits one span between plan vertices and vertical segment boundaries may
/// use to bring its chords within tolerance. A span that needs more keeps
/// its last, coarser chords.
const MAX_SPAN_SPLITS: usize = 1024;

/// A swept area solid's `StartParam` / `EndParam`. IFC4x3 types them as
/// `IfcCurveMeasureSelect`: an `IfcParameterValue` is a parameter of the
/// directrix, an `IfcLengthMeasure` a length along it. IFC4 wrote a bare
/// `IfcParameterValue`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum CurveMeasure {
    Parameter(f64),
    Length(f64),
}

impl CurveMeasure {
    /// Read the select at `slot`, keeping which of the two it is.
    pub(crate) fn read(entity: &DecodedEntity, slot: impl slot::AnySlot) -> Option<Self> {
        let value = entity.attr(slot)?;
        let number = value.as_float()?;
        Some(if value.typed_value("IFCLENGTHMEASURE").is_some() {
            Self::Length(number)
        } else {
            Self::Parameter(number)
        })
    }

    /// The number as written. Directrix types other than `IfcGradientCurve`
    /// read it as their parameter, as before the select was told apart.
    pub(crate) fn value(self) -> f64 {
        match self {
            Self::Parameter(v) | Self::Length(v) => v,
        }
    }
}

/// Directrix samples, with the curve's own unit tangent at each sample when
/// it has one, so the section frame does not depend on the chords: two sweeps
/// that meet at a point share its tangent there.
pub(crate) struct DirectrixSamples {
    pub(crate) points: Vec<Point3<f64>>,
    pub(crate) tangents: Option<Vec<Vector3<f64>>>,
}

impl ProfileProcessor {
    /// [`Self::get_directrix_points`] for a swept area solid, whose bounds
    /// may be lengths, with the evaluated tangents of a gradient directrix.
    pub(crate) fn get_directrix_samples(
        &self,
        directrix: &DecodedEntity,
        decoder: &mut EntityDecoder,
        start: Option<CurveMeasure>,
        end: Option<CurveMeasure>,
        quality: TessellationQuality,
    ) -> Result<DirectrixSamples> {
        self.set_tessellation_quality(quality);
        if directrix.ifc_type == IfcType::IfcGradientCurve {
            if let Some(samples) = self.get_gradient_directrix(directrix, decoder, start, end)? {
                return Ok(samples);
            }
        }
        let points = self.get_directrix_points(
            directrix,
            decoder,
            start.map(CurveMeasure::value),
            end.map(CurveMeasure::value),
            quality,
        )?;
        Ok(DirectrixSamples { points, tangents: None })
    }

    /// Sample an `IfcGradientCurve` over `[start, end]`, clamped to its plan.
    ///
    /// - A parameter is the `BaseCurve`'s, which is horizontal distance when
    ///   the base is a composite of length-measured `IfcCurveSegment`s (every
    ///   alignment export). Any other base has a parameter this reader does
    ///   not map, so a parameter trim on it returns `None`.
    /// - A length is measured along the 3D curve and mapped to horizontal
    ///   distance through the shared [`ArcLengthMap`].
    ///
    /// Samples fall on every plan vertex and vertical segment boundary. Each
    /// span between them is halved until no chord strays more than
    /// [`CHORD_TOL_M`] (scaled by the quality) from the profile, or until the
    /// span has used [`MAX_SPAN_SPLITS`]. `Ok(None)` also when the vertical
    /// profile cannot be read; the caller then keeps the plain-curve path.
    pub(super) fn get_gradient_directrix(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        start: Option<CurveMeasure>,
        end: Option<CurveMeasure>,
    ) -> Result<Option<DirectrixSamples>> {
        let parameter_trim = [start, end].iter().any(|m| matches!(m, Some(CurveMeasure::Parameter(_))));
        if parameter_trim && !base_is_distance_parameterised(curve, decoder)? {
            return Ok(None);
        }
        let Some(alignment) = AlignmentCurve::parse(curve, decoder)? else {
            return Ok(None);
        };
        let length = alignment.horizontal_length();
        let lengths = [start, end].iter().any(|m| matches!(m, Some(CurveMeasure::Length(_))));
        let arc = lengths.then(|| ArcLengthMap::new(&alignment));
        let station = |m: CurveMeasure| match (m, &arc) {
            (CurveMeasure::Length(l), Some(arc)) => arc.horizontal_station(l),
            (m, _) => m.value(),
        };
        let start = start.map_or(0.0, station).max(0.0);
        let end = end.map_or(length, station).min(length);
        if !(start.is_finite() && end.is_finite()) || end <= start {
            return Ok(Some(DirectrixSamples { points: Vec::new(), tangents: Some(Vec::new()) }));
        }
        let mut breaks = vec![start];
        breaks.extend(alignment.station_breaks().into_iter().filter(|s| *s > start && *s < end));
        breaks.push(end);

        let density = self.quality().density_factor();
        let tolerance = CHORD_TOL_M / decoder.length_unit_scale() / (density * density);
        let mut stations = vec![start];
        for span in breaks.windows(2) {
            refine_span(&alignment, span[0], span[1], tolerance, &mut stations);
        }
        let frames: Vec<_> = stations.into_iter().map(|s| alignment.evaluate(s)).collect();
        Ok(Some(DirectrixSamples {
            points: frames.iter().map(|f| f.origin).collect(),
            tangents: Some(frames.iter().map(|f| f.tangent).collect()),
        }))
    }
}

/// Whether the `BaseCurve` parameter is horizontal distance: a plain
/// `IfcCompositeCurve` whose segments are all `IfcCurveSegment`s measured
/// by `IfcLengthMeasure` (IFC4x3: the composite's parameter is the running
/// sum of its segments' lengths).
fn base_is_distance_parameterised(curve: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<bool> {
    let Some(base_id) = curve.ref_at(slot::IfcGradientCurve::BASE_CURVE) else {
        return Ok(false);
    };
    let base = decoder.decode_by_id(base_id)?;
    if base.ifc_type != IfcType::IfcCompositeCurve {
        return Ok(false);
    }
    let Some(segments) = base.ref_list_at(slot::IfcCompositeCurve::SEGMENTS) else {
        return Ok(false);
    };
    for id in segments {
        let segment = decoder.decode_by_id(id)?;
        let measured = segment.ifc_type == IfcType::IfcCurveSegment
            && segment
                .attr(slot::IfcCurveSegment::SEGMENT_LENGTH)
                .is_some_and(|v| v.typed_value("IFCLENGTHMEASURE").is_some());
        if !measured {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Append the stations after `a` up to `b` at which the chords of the 3D
/// curve stay within `tolerance` of it. Within one span the plan is a single
/// straight chord and the profile one segment with a monotone grade, so the
/// worst point of a chord is where the profile's grade equals the chord's
/// slope; that point's vertical offset is the chord's exact error (and an
/// upper bound on its perpendicular one). Spans are halved until each chord
/// passes or the split budget is spent.
fn refine_span(alignment: &AlignmentCurve, a: f64, b: f64, tolerance: f64, stations: &mut Vec<f64>) {
    let mut budget = MAX_SPAN_SPLITS;
    let mut pending = vec![(a, b)];
    while let Some((lo, hi)) = pending.pop() {
        if budget > 0 && chord_error(alignment, lo, hi) > tolerance {
            budget -= 1;
            let mid = 0.5 * (lo + hi);
            pending.push((mid, hi));
            pending.push((lo, mid));
        } else {
            stations.push(hi);
        }
    }
}

/// Largest vertical distance between the profile and its chord over
/// `[lo, hi]`, for a profile whose grade is monotone there.
fn chord_error(alignment: &AlignmentCurve, lo: f64, hi: f64) -> f64 {
    let profile = |s: f64| {
        let frame = alignment.evaluate(s);
        let horizontal = frame.tangent.x.hypot(frame.tangent.y);
        (frame.origin.z, frame.tangent.z / horizontal)
    };
    let ((z_lo, g_lo), (z_hi, g_hi)) = (profile(lo), profile(hi));
    let slope = (z_hi - z_lo) / (hi - lo);
    if (g_hi - g_lo).abs() <= f64::EPSILON || !slope.is_finite() {
        return 0.0;
    }
    // Bisect for the station whose grade equals the chord's slope.
    let rising = g_hi > g_lo;
    let (mut left, mut right) = (lo, hi);
    for _ in 0..60 {
        let middle = 0.5 * (left + right);
        if (profile(middle).1 < slope) == rising {
            left = middle;
        } else {
            right = middle;
        }
    }
    let s = 0.5 * (left + right);
    (profile(s).0 - (z_lo + slope * (s - lo))).abs()
}

#[cfg(test)]
#[path = "directrix_gradient_tests.rs"]
mod tests;
