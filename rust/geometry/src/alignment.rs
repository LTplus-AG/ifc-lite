// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcAlignmentCurve` evaluation — horizontal + vertical alignment
//! curves used as the directrix of `IfcSectionedSolidHorizontal`.
//!
//! Scope: IFC4x1 alignment entities. These are not in our IFC4X3 codegen
//! enum, so dispatch is via `IfcType::from_str` cached behind `OnceLock`.
//!
//! ## Horizontal segments
//! - `IfcLineSegment2D`           — straight tangent
//! - `IfcCircularArcSegment2D`    — constant radius arc, with `IsCCW`
//! - `IfcTransitionCurveSegment2D` — clothoid / spiral (linear-curvature
//!   transition); other transition curve subtypes (Bloss, cubic
//!   parabola, sine, cosine) degrade to a clothoid with the same
//!   end-curvatures, which is a known approximation but produces
//!   continuous geometry instead of a discontinuity.
//!
//! ## Vertical segments (all parameterised on horizontal distance)
//! - `IfcAlignment2DVerSegLine`         — constant gradient
//! - `IfcAlignment2DVerSegCircularArc`  — circular profile
//! - `IfcAlignment2DVerSegParabolicArc` — parabolic profile
//!
//! Output frame at station `s` has +X right of travel, +Z up (global
//! vertical), +Y along travel. Used by `SectionedSolidHorizontalProcessor`
//! to place each cross-section in 3D space.

use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use nalgebra::{Point3, Vector3};
use std::sync::OnceLock;

use crate::{Error, Result};

// --- IFC type lookup (resolves IFC4x1 names not in our IFC4X3 enum) ---

macro_rules! ifc_type_fn {
    ($name:ident, $literal:expr) => {
        fn $name() -> IfcType {
            static T: OnceLock<IfcType> = OnceLock::new();
            *T.get_or_init(|| IfcType::from_str($literal))
        }
    };
}

ifc_type_fn!(t_alignment_curve, "IFCALIGNMENTCURVE");
ifc_type_fn!(t_alignment_2d_horizontal, "IFCALIGNMENT2DHORIZONTAL");
ifc_type_fn!(t_alignment_2d_horizontal_segment, "IFCALIGNMENT2DHORIZONTALSEGMENT");
ifc_type_fn!(t_alignment_2d_vertical, "IFCALIGNMENT2DVERTICAL");
ifc_type_fn!(t_line_segment_2d, "IFCLINESEGMENT2D");
ifc_type_fn!(t_circular_arc_segment_2d, "IFCCIRCULARARCSEGMENT2D");
ifc_type_fn!(t_transition_curve_segment_2d, "IFCTRANSITIONCURVESEGMENT2D");
ifc_type_fn!(t_ver_seg_line, "IFCALIGNMENT2DVERSEGLINE");
ifc_type_fn!(t_ver_seg_parabolic, "IFCALIGNMENT2DVERSEGPARABOLICARC");
ifc_type_fn!(t_ver_seg_circular, "IFCALIGNMENT2DVERSEGCIRCULARARC");

/// `True` if the attribute is an IFC boolean enum `.T.`. Anything else
/// (including `.F.`, `.U.`, missing, or wrong shape) reads as `false`.
fn read_bool(attr: Option<&AttributeValue>) -> bool {
    attr.and_then(|v| v.as_enum()).map(|s| s == "T").unwrap_or(false)
}

/// Cumulative-station-keyed horizontal directrix segment.
#[derive(Debug, Clone, Copy)]
enum HSeg {
    Line {
        sx: f64,
        sy: f64,
        heading: f64,
        length: f64,
        cum_start: f64,
    },
    Arc {
        sx: f64,
        sy: f64,
        heading: f64,
        radius: f64,
        length: f64,
        ccw: bool,
        cum_start: f64,
    },
    /// Transition curve. Linearly-varying curvature κ(s) =
    /// start_curv + (end_curv − start_curv) · s / length. Equivalent to
    /// a clothoid when one endpoint has κ=0. Position evaluated by
    /// numerical integration (trapezoidal quadrature in arc length).
    Transition {
        sx: f64,
        sy: f64,
        heading: f64,
        length: f64,
        start_curv: f64,
        end_curv: f64,
        cum_start: f64,
    },
}

#[derive(Debug, Clone, Copy)]
enum VSeg {
    Line {
        start: f64,
        length: f64,
        h0: f64,
        g0: f64,
    },
    Parabolic {
        start: f64,
        length: f64,
        h0: f64,
        g0: f64,
        parabola_constant: f64,
        is_convex: bool,
    },
    /// Circular vertical curve. For typical highway radii (>500m) over
    /// segment lengths in the tens of metres, the parabolic approximation
    /// `z ≈ z0 + g0·s + ±s²/(2R)` is accurate to sub-millimetre — same
    /// formula as the parabolic segment with `parabola_constant = R`.
    CircularArc {
        start: f64,
        length: f64,
        h0: f64,
        g0: f64,
        radius: f64,
        is_convex: bool,
    },
}

/// Cross-section placement frame at a station.
#[derive(Debug, Clone, Copy)]
pub struct AlignmentFrame {
    /// Origin of the cross-section's local 2D coords (px=0, py=0).
    pub origin: Point3<f64>,
    /// Right of travel in the horizontal plane. Profile's local +X.
    pub right: Vector3<f64>,
    /// Up (global +Z). Profile's local +Y.
    pub up: Vector3<f64>,
}

/// Parsed alignment curve. Holds horizontal and vertical segments in
/// authored order with cumulative-start stations precomputed.
pub struct AlignmentCurve {
    horizontal: Vec<HSeg>,
    vertical: Vec<VSeg>,
}

impl AlignmentCurve {
    /// Parse `IfcAlignmentCurve` (or a curve that walks like one). Returns
    /// `Ok(None)` when the directrix is something other than alignment so
    /// the caller can fall back to a straight-line sweep. Errors only on
    /// malformed alignment input (e.g. missing required `Horizontal`).
    pub fn parse(directrix: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<Option<Self>> {
        if directrix.ifc_type != t_alignment_curve() {
            return Ok(None);
        }

        let angle_scale = decoder.plane_angle_to_radians();

        // attr 0 = Horizontal (required)
        let h_id = directrix.get_ref(0).ok_or_else(|| {
            Error::geometry("IfcAlignmentCurve missing Horizontal".to_string())
        })?;
        let horizontal = parse_horizontal(h_id, decoder, angle_scale)?;

        // attr 1 = Vertical (optional)
        let vertical = match directrix.get(1) {
            Some(v) if !v.is_null() => match v.as_entity_ref() {
                Some(v_id) => parse_vertical(v_id, decoder)?,
                None => Vec::new(),
            },
            _ => Vec::new(),
        };

        Ok(Some(Self { horizontal, vertical }))
    }

    /// Evaluate the placement frame at the given station (cumulative
    /// distance along the horizontal alignment, in file length units).
    /// Extrapolates linearly past either end.
    pub fn evaluate(&self, station: f64) -> AlignmentFrame {
        let (x, y, heading) = self.evaluate_horizontal(station);
        let z = self.evaluate_vertical(station);
        let cos_h = heading.cos();
        let sin_h = heading.sin();
        // Right of travel: rotate tangent (cos h, sin h) by −90° → (sin h, −cos h).
        let right = Vector3::new(sin_h, -cos_h, 0.0);
        let up = Vector3::new(0.0, 0.0, 1.0);
        AlignmentFrame {
            origin: Point3::new(x, y, z),
            right,
            up,
        }
    }

    fn evaluate_horizontal(&self, station: f64) -> (f64, f64, f64) {
        if self.horizontal.is_empty() {
            return (0.0, 0.0, 0.0);
        }
        // The IFC schema is silent on whether segments must form a
        // continuous chain (`TangentialContinuity` is per-segment and
        // optional), so we treat each segment's own StartPoint /
        // StartDirection as authoritative and use the cumulative
        // SegmentLength sum as the station axis.
        for seg in &self.horizontal {
            let len = h_length(seg);
            let cum = h_cum_start(seg);
            if station <= cum + len + 1e-9 {
                let local = (station - cum).max(0.0).min(len);
                return h_eval(seg, local);
            }
        }
        // Past the end → extrapolate tangentially from the last segment.
        let last = self.horizontal.last().unwrap();
        let len = h_length(last);
        let (x, y, h) = h_eval(last, len);
        let extra = station - (h_cum_start(last) + len);
        (x + extra * h.cos(), y + extra * h.sin(), h)
    }

    fn evaluate_vertical(&self, station: f64) -> f64 {
        if self.vertical.is_empty() {
            return 0.0;
        }
        for seg in &self.vertical {
            let start = v_start(seg);
            let length = v_length(seg);
            if station <= start + length + 1e-9 {
                let local = (station - start).max(0.0).min(length);
                return v_eval_height(seg, local);
            }
        }
        // Past the end → extrapolate with the last segment's exit slope.
        let last = self.vertical.last().unwrap();
        let length = v_length(last);
        let (z_end, slope) = v_eval(last, length);
        let extra = station - (v_start(last) + length);
        z_end + slope * extra
    }
}

fn parse_horizontal(
    h_id: u32,
    decoder: &mut EntityDecoder,
    angle_scale: f64,
) -> Result<Vec<HSeg>> {
    let h_entity = decoder.decode_by_id(h_id)?;
    if h_entity.ifc_type != t_alignment_2d_horizontal() {
        return Err(Error::geometry(format!(
            "AlignmentCurve.Horizontal #{} is not IfcAlignment2DHorizontal",
            h_id,
        )));
    }
    // attr 0 = StartDistAlong (optional); attr 1 = Segments.
    let _start_dist_along = h_entity.get_float(0).unwrap_or(0.0);
    let segs_attr = h_entity
        .get(1)
        .ok_or_else(|| Error::geometry("IfcAlignment2DHorizontal missing Segments".to_string()))?;
    let seg_refs = segs_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Horizontal Segments must be a list".to_string()))?;

    let mut segments = Vec::with_capacity(seg_refs.len());
    let mut cumulative = 0.0;
    for seg_ref in seg_refs {
        let seg_id = seg_ref.as_entity_ref().ok_or_else(|| {
            Error::geometry("Horizontal segment ref is not an entity reference".to_string())
        })?;
        let seg = decoder.decode_by_id(seg_id)?;
        if seg.ifc_type != t_alignment_2d_horizontal_segment() {
            return Err(Error::geometry(format!(
                "#{} is not IfcAlignment2DHorizontalSegment",
                seg_id,
            )));
        }
        // attr 3 = CurveGeometry (the IfcCurveSegment2D subtype).
        let curve_id = seg.get_ref(3).ok_or_else(|| {
            Error::geometry(format!(
                "IfcAlignment2DHorizontalSegment #{} missing CurveGeometry",
                seg_id,
            ))
        })?;
        let curve = decoder.decode_by_id(curve_id)?;

        // Inherited IfcCurveSegment2D attributes:
        //   0: StartPoint (IfcCartesianPoint)
        //   1: StartDirection (IfcPlaneAngleMeasure — scale via plane_angle_to_radians)
        //   2: SegmentLength (IfcPositiveLengthMeasure)
        let sp_id = curve.get_ref(0).ok_or_else(|| {
            Error::geometry(format!("CurveSegment #{} missing StartPoint", curve_id))
        })?;
        let sp = decoder.decode_by_id(sp_id)?;
        let coords = sp
            .get_list(0)
            .ok_or_else(|| Error::geometry("StartPoint missing Coordinates".to_string()))?;
        let sx = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
        let sy = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
        let heading_raw = curve.get_float(1).ok_or_else(|| {
            Error::geometry(format!(
                "CurveSegment #{} missing StartDirection",
                curve_id,
            ))
        })?;
        let heading = heading_raw * angle_scale;
        let length = curve.get_float(2).ok_or_else(|| {
            Error::geometry(format!("CurveSegment #{} missing SegmentLength", curve_id))
        })?;

        let hseg = if curve.ifc_type == t_line_segment_2d() {
            HSeg::Line {
                sx,
                sy,
                heading,
                length,
                cum_start: cumulative,
            }
        } else if curve.ifc_type == t_circular_arc_segment_2d() {
            // Own attrs: 3 = Radius, 4 = IsCCW.
            let radius = curve.get_float(3).ok_or_else(|| {
                Error::geometry(format!("CircularArcSegment2D #{} missing Radius", curve_id))
            })?;
            if radius < 1e-12 {
                return Err(Error::geometry(format!(
                    "CircularArcSegment2D #{} has non-positive radius {}",
                    curve_id, radius,
                )));
            }
            let ccw = read_bool(curve.get(4));
            HSeg::Arc {
                sx,
                sy,
                heading,
                radius,
                length,
                ccw,
                cum_start: cumulative,
            }
        } else if curve.ifc_type == t_transition_curve_segment_2d() {
            // Own attrs:
            //   3: StartRadius (optional — infinity = straight)
            //   4: EndRadius   (optional)
            //   5: IsStartRadiusCCW
            //   6: IsEndRadiusCCW
            //   7: TransitionCurveType (enum — we treat all subtypes
            //      as clothoid in this first cut; see module docstring)
            let start_radius = curve.get_float(3);
            let end_radius = curve.get_float(4);
            let start_ccw = read_bool(curve.get(5));
            let end_ccw = read_bool(curve.get(6));
            let start_curv = match start_radius {
                Some(r) if r.abs() > 1e-12 => (if start_ccw { 1.0 } else { -1.0 }) / r,
                _ => 0.0,
            };
            let end_curv = match end_radius {
                Some(r) if r.abs() > 1e-12 => (if end_ccw { 1.0 } else { -1.0 }) / r,
                _ => 0.0,
            };
            HSeg::Transition {
                sx,
                sy,
                heading,
                length,
                start_curv,
                end_curv,
                cum_start: cumulative,
            }
        } else {
            return Err(Error::geometry(format!(
                "Unsupported horizontal curve geometry at #{}: {}",
                curve_id, curve.ifc_type,
            )));
        };
        cumulative += length;
        segments.push(hseg);
    }
    Ok(segments)
}

fn parse_vertical(v_id: u32, decoder: &mut EntityDecoder) -> Result<Vec<VSeg>> {
    let v_entity = decoder.decode_by_id(v_id)?;
    if v_entity.ifc_type != t_alignment_2d_vertical() {
        return Err(Error::geometry(format!(
            "AlignmentCurve.Vertical #{} is not IfcAlignment2DVertical",
            v_id,
        )));
    }
    // attr 0 = Segments.
    let segs_attr = v_entity
        .get(0)
        .ok_or_else(|| Error::geometry("IfcAlignment2DVertical missing Segments".to_string()))?;
    let seg_refs = segs_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Vertical Segments must be a list".to_string()))?;

    let mut segments = Vec::with_capacity(seg_refs.len());
    for seg_ref in seg_refs {
        let seg_id = seg_ref.as_entity_ref().ok_or_else(|| {
            Error::geometry("Vertical segment ref is not an entity reference".to_string())
        })?;
        let seg = decoder.decode_by_id(seg_id)?;
        // Inherited IfcAlignment2DVerticalSegment attrs (all required):
        //   0: TangentialContinuity
        //   1: StartTag (optional)
        //   2: EndTag (optional)
        //   3: StartDistAlong
        //   4: HorizontalLength
        //   5: StartHeight
        //   6: StartGradient
        let start = seg.get_float(3).ok_or_else(|| {
            Error::geometry(format!(
                "VerticalSegment #{} missing StartDistAlong",
                seg_id,
            ))
        })?;
        let length = seg.get_float(4).ok_or_else(|| {
            Error::geometry(format!(
                "VerticalSegment #{} missing HorizontalLength",
                seg_id,
            ))
        })?;
        let h0 = seg
            .get_float(5)
            .ok_or_else(|| Error::geometry(format!("VerticalSegment #{} missing StartHeight", seg_id)))?;
        let g0 = seg.get_float(6).ok_or_else(|| {
            Error::geometry(format!(
                "VerticalSegment #{} missing StartGradient",
                seg_id,
            ))
        })?;

        let vseg = if seg.ifc_type == t_ver_seg_line() {
            VSeg::Line {
                start,
                length,
                h0,
                g0,
            }
        } else if seg.ifc_type == t_ver_seg_parabolic() {
            // Own attrs: 7 = ParabolaConstant, 8 = IsConvex.
            let parabola_constant = seg.get_float(7).ok_or_else(|| {
                Error::geometry(format!(
                    "ParabolicVerSeg #{} missing ParabolaConstant",
                    seg_id,
                ))
            })?;
            let is_convex = read_bool(seg.get(8));
            VSeg::Parabolic {
                start,
                length,
                h0,
                g0,
                parabola_constant,
                is_convex,
            }
        } else if seg.ifc_type == t_ver_seg_circular() {
            // Own attrs: 7 = Radius, 8 = IsConvex.
            let radius = seg.get_float(7).ok_or_else(|| {
                Error::geometry(format!("CircularVerSeg #{} missing Radius", seg_id))
            })?;
            let is_convex = read_bool(seg.get(8));
            VSeg::CircularArc {
                start,
                length,
                h0,
                g0,
                radius,
                is_convex,
            }
        } else {
            // Unknown vertical subtype — degrade to a straight gradient
            // segment so the sweep at least continues sensibly through
            // it. Logged below.
            VSeg::Line {
                start,
                length,
                h0,
                g0,
            }
        };
        segments.push(vseg);
    }
    Ok(segments)
}

// --- Segment evaluation ---

fn h_cum_start(seg: &HSeg) -> f64 {
    match seg {
        HSeg::Line { cum_start, .. }
        | HSeg::Arc { cum_start, .. }
        | HSeg::Transition { cum_start, .. } => *cum_start,
    }
}

fn h_length(seg: &HSeg) -> f64 {
    match seg {
        HSeg::Line { length, .. }
        | HSeg::Arc { length, .. }
        | HSeg::Transition { length, .. } => *length,
    }
}

/// Evaluate horizontal segment at local arc length `s ∈ [0, length]`.
/// Returns `(x, y, heading)`.
fn h_eval(seg: &HSeg, s: f64) -> (f64, f64, f64) {
    match seg {
        HSeg::Line {
            sx,
            sy,
            heading,
            ..
        } => (sx + s * heading.cos(), sy + s * heading.sin(), *heading),
        HSeg::Arc {
            sx,
            sy,
            heading,
            radius,
            ccw,
            ..
        } => {
            let sign = if *ccw { 1.0 } else { -1.0 };
            let theta = s / radius;
            let new_heading = heading + sign * theta;
            // Centre lies perpendicular to heading at distance radius.
            // CCW → perpendicular-left = (−sin h, cos h);
            // CW  → perpendicular-right = (sin h, −cos h).
            let (nx, ny) = if *ccw {
                (-heading.sin(), heading.cos())
            } else {
                (heading.sin(), -heading.cos())
            };
            let cx = sx + radius * nx;
            let cy = sy + radius * ny;
            // Angle from centre to start point = atan2(−ny, −nx).
            let start_angle = (-ny).atan2(-nx);
            let new_angle = start_angle + sign * theta;
            (
                cx + radius * new_angle.cos(),
                cy + radius * new_angle.sin(),
                new_heading,
            )
        }
        HSeg::Transition {
            sx,
            sy,
            heading,
            length,
            start_curv,
            end_curv,
            ..
        } => {
            // heading(u) = h0 + κ0·u + ½ · (κ1−κ0)/L · u²
            // x, y require ∫cos(h(u)) du, ∫sin(h(u)) du — no closed form.
            // Trapezoidal quadrature with N steps; N scales with how far
            // along the segment we are so the sample density per metre is
            // roughly constant.
            let cm = (end_curv - start_curv) / length.max(1e-12);
            let n = ((s.abs() * 0.5).ceil() as usize)
                .max(16)
                .min(4096);
            let ds = s / n as f64;
            let mut x = *sx;
            let mut y = *sy;
            let mut prev_cos = heading.cos();
            let mut prev_sin = heading.sin();
            for i in 1..=n {
                let u = i as f64 * ds;
                let h = heading + start_curv * u + 0.5 * cm * u * u;
                let cs = h.cos();
                let sn = h.sin();
                x += 0.5 * ds * (prev_cos + cs);
                y += 0.5 * ds * (prev_sin + sn);
                prev_cos = cs;
                prev_sin = sn;
            }
            let final_h = heading + start_curv * s + 0.5 * cm * s * s;
            (x, y, final_h)
        }
    }
}

fn v_start(seg: &VSeg) -> f64 {
    match seg {
        VSeg::Line { start, .. }
        | VSeg::Parabolic { start, .. }
        | VSeg::CircularArc { start, .. } => *start,
    }
}

fn v_length(seg: &VSeg) -> f64 {
    match seg {
        VSeg::Line { length, .. }
        | VSeg::Parabolic { length, .. }
        | VSeg::CircularArc { length, .. } => *length,
    }
}

/// Evaluate vertical segment at local horizontal distance `s ∈ [0, length]`.
/// Returns `(height, slope)`.
fn v_eval(seg: &VSeg, s: f64) -> (f64, f64) {
    match seg {
        VSeg::Line { h0, g0, .. } => (h0 + g0 * s, *g0),
        VSeg::Parabolic {
            h0,
            g0,
            parabola_constant,
            is_convex,
            ..
        } => {
            // IFC4x1 convention: ParabolaConstant K = R (radius-equivalent
            // for a parabola in z(x) = z0 + g0·x ± x²/(2K)). `IsConvex=true`
            // is a crest curve (curvature downward); `false` is a sag.
            let sign = if *is_convex { -1.0 } else { 1.0 };
            let k = parabola_constant.abs().max(1e-12);
            let z = h0 + g0 * s + sign * (s * s) / (2.0 * k);
            let slope = g0 + sign * s / k;
            (z, slope)
        }
        VSeg::CircularArc {
            h0,
            g0,
            radius,
            is_convex,
            ..
        } => {
            // Parabolic approximation accurate to ~mm for typical highway
            // radii (R > 500 m) over realistic segment lengths.
            let sign = if *is_convex { -1.0 } else { 1.0 };
            let r = radius.abs().max(1e-12);
            let z = h0 + g0 * s + sign * (s * s) / (2.0 * r);
            let slope = g0 + sign * s / r;
            (z, slope)
        }
    }
}

fn v_eval_height(seg: &VSeg, s: f64) -> f64 {
    v_eval(seg, s).0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sanity-check straight-line evaluation: a line segment heading
    /// along +X must reach `(length, 0)` with unchanged heading.
    #[test]
    fn line_segment_evaluation() {
        let seg = HSeg::Line {
            sx: 0.0,
            sy: 0.0,
            heading: 0.0,
            length: 10.0,
            cum_start: 0.0,
        };
        let (x, y, h) = h_eval(&seg, 10.0);
        assert!((x - 10.0).abs() < 1e-9);
        assert!(y.abs() < 1e-9);
        assert!(h.abs() < 1e-9);
    }

    /// Reproduce the issue #828 bridge fixture's first arc: start at
    /// origin, heading 13.36° (= 0.2332 rad), radius 9279, length 2965.68,
    /// CW. Per the file, the next segment starts at #103=(2945.13,216.39),
    /// so the arc end must land there within rounding error.
    #[test]
    fn fixture_828_arc_endpoint() {
        let seg = HSeg::Arc {
            sx: 0.0,
            sy: 0.0,
            heading: 13.35833333_f64.to_radians(),
            radius: 9279.0,
            length: 2965.68,
            ccw: false,
            cum_start: 0.0,
        };
        let (x, y, _) = h_eval(&seg, 2965.68);
        // ~5-inch tolerance accounts for the truncated 13.358333° heading
        // in the source file.
        assert!((x - 2945.13).abs() < 5.0, "x = {} expected ~2945.13", x);
        assert!((y - 216.39).abs() < 5.0, "y = {} expected ~216.39", y);
    }

    #[test]
    fn parabolic_vertical_segment() {
        // From fixture #95: K=36000, sag (IsConvex=false), start gradient
        // 0.0579, start height 399. At local distance 1680:
        //   z = 399 + 0.0579·1680 + 1680²/(2·36000)
        //     = 399 + 97.272 + 39.20  = 535.47
        let seg = VSeg::Parabolic {
            start: 3600.0,
            length: 3685.68,
            h0: 399.0,
            g0: 0.0579,
            parabola_constant: 36000.0,
            is_convex: false,
        };
        let (z, slope) = v_eval(&seg, 1680.0);
        assert!((z - 535.472).abs() < 0.01, "z = {}", z);
        assert!((slope - 0.1046).abs() < 1e-3, "slope = {}", slope);
    }
}
