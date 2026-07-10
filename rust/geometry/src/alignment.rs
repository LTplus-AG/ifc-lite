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

/// IFC4x1 `IfcTransitionCurveType` enumeration. The curvature varies
/// from `start_curv` at `s=0` to `end_curv` at `s=L` along a profile
/// that depends on the subtype.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransitionKind {
    /// Linear curvature: `κ(s) = κ₀ + (κ₁-κ₀)·(s/L)`. Euler spiral.
    Clothoid,
    /// Cubic smoothstep: `κ(s) = κ₀ + (κ₁-κ₀)·(3u² − 2u³)` (u = s/L).
    Bloss,
    /// Cosine taper: `κ(s) = κ₀ + (κ₁-κ₀)·(1 − cos(π·u))/2`.
    Cosine,
    /// Sine taper: `κ(s) = κ₀ + (κ₁-κ₀)·(u − sin(2π·u)/(2π))`.
    Sine,
    /// Approximated as clothoid — the canonical cubic-parabola
    /// formulation `y = x³/(6RL)` is linear-in-x curvature, which is
    /// `≈` linear-in-s for short transitions (the railway-engineering
    /// regime where this subtype is authored).
    CubicParabola,
    /// Same approximation as `Bloss` (quintic smooth blend) — the
    /// biquadratic-parabola subtype has two parabolic halves whose
    /// curvature joins continuously at `s=L/2`, equivalent visually
    /// to a Bloss blend for typical transition lengths.
    BiquadraticParabola,
}

impl TransitionKind {
    fn from_enum(name: &str) -> Self {
        match name {
            "CLOTHOIDCURVE" => Self::Clothoid,
            "BLOSSCURVE" => Self::Bloss,
            "COSINECURVE" => Self::Cosine,
            "SINECURVE" => Self::Sine,
            "CUBICPARABOLA" => Self::CubicParabola,
            "BIQUADRATICPARABOLA" => Self::BiquadraticParabola,
            // Unknown subtypes fall back to clothoid (most common).
            _ => Self::Clothoid,
        }
    }

    /// `g(u) = ∫₀ᵘ shape(v) dv` where `shape(v)` is the curvature blend
    /// profile (=0 at u=0, =1 at u=1). Used to evaluate the heading
    /// closed-form: `h(s) = h₀ + κ₀·s + (κ₁-κ₀)·L·g(s/L)`.
    fn heading_integral(self, u: f64) -> f64 {
        let u = u.clamp(0.0, 1.0);
        match self {
            Self::Clothoid | Self::CubicParabola => 0.5 * u * u,
            Self::Bloss | Self::BiquadraticParabola => {
                // ∫(3v² − 2v³)dv = v³ − v⁴/2
                u * u * u - 0.5 * u * u * u * u
            }
            Self::Cosine => {
                // ∫½(1 − cos(πv))dv = v/2 − sin(πv)/(2π)
                0.5 * u - (std::f64::consts::PI * u).sin() / (2.0 * std::f64::consts::PI)
            }
            Self::Sine => {
                // ∫(v − sin(2πv)/(2π))dv = v²/2 + cos(2πv)/(4π²) − 1/(4π²)
                let two_pi = 2.0 * std::f64::consts::PI;
                0.5 * u * u + ((two_pi * u).cos() - 1.0) / (4.0 * std::f64::consts::PI.powi(2))
            }
        }
    }
}

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
    /// Transition curve. Curvature varies smoothly from `start_curv` to
    /// `end_curv` along arc length according to the `kind`'s blend
    /// profile. Position evaluated by numerical integration of
    /// `(cos h(s), sin h(s))` ds — no closed form for the Fresnel-style
    /// integrals these curves produce.
    Transition {
        sx: f64,
        sy: f64,
        heading: f64,
        length: f64,
        start_curv: f64,
        end_curv: f64,
        kind: TransitionKind,
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
    /// Right of travel in the horizontal plane. Profile's local +X
    /// when `FixedAxisVertical = true`. Always lies in the world XY
    /// plane: `(sin h, −cos h, 0)`.
    pub right: Vector3<f64>,
    /// Up (global +Z). Profile's local +Y when `FixedAxisVertical = true`.
    pub up: Vector3<f64>,
    /// Unit tangent of the 3D directrix at this station. Includes the
    /// longitudinal slope from the vertical alignment.
    pub tangent: Vector3<f64>,
}

/// Parsed alignment curve. Holds horizontal and vertical segments in
/// authored order with cumulative-start stations precomputed.
pub struct AlignmentCurve {
    horizontal: Vec<HSeg>,
    vertical: Vec<VSeg>,
}

impl AlignmentCurve {
    /// Parse `IfcAlignmentCurve` (or any directrix we can reduce to a
    /// piecewise alignment). Recognised cases:
    ///
    /// - `IfcAlignmentCurve` — horizontal + (optional) vertical parsing.
    /// - `IfcPolyline` — synthesised as a chain of line segments. Each
    ///   polyline edge becomes one `HSeg::Line` (in XY) and one
    ///   `VSeg::Line` (with gradient = dz / horizontal length). This
    ///   covers the relatively rare case of a sectioned-solid authored
    ///   with a polyline directrix, which is spec-allowed but uncommon.
    ///
    /// Returns `Ok(None)` for any other directrix so the caller can
    /// fall back to a straight-line sweep. Errors only on malformed
    /// recognised input (e.g. an `IfcAlignmentCurve` missing
    /// `Horizontal`).
    pub fn parse(directrix: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<Option<Self>> {
        if directrix.ifc_type == IfcType::IfcPolyline {
            return Self::from_polyline(directrix, decoder).map(Some);
        }
        if directrix.ifc_type != t_alignment_curve() {
            return Ok(None);
        }

        let angle_scale = decoder.plane_angle_to_radians();

        // attr 0 = Horizontal (required)
        let h_id = directrix.get_ref(0).ok_or_else(|| {
            Error::geometry("IfcAlignmentCurve missing Horizontal".to_string())
        })?;
        // `horizontal_base` is the horizontal alignment's `StartDistAlong`
        // — the chainage value at the physical start of the alignment.
        // The horizontal geometry itself is indexed by a cumulative
        // segment-length station that starts at 0, so this base is only
        // needed to rebase the vertical segments (whose `StartDistAlong`
        // are authored as absolute chainages in the same domain) onto
        // that same 0-origin axis. See `parse_vertical`.
        let (horizontal, horizontal_base) = parse_horizontal(h_id, decoder, angle_scale)?;

        // attr 1 = Vertical (optional)
        let vertical = match directrix.get(1) {
            Some(v) if !v.is_null() => match v.as_entity_ref() {
                Some(v_id) => parse_vertical(v_id, decoder, horizontal_base)?,
                None => Vec::new(),
            },
            _ => Vec::new(),
        };

        Ok(Some(Self { horizontal, vertical }))
    }

    /// Total length of the horizontal alignment (sum of segment lengths).
    pub fn horizontal_length(&self) -> f64 {
        self.horizontal
            .last()
            .map(|s| h_cum_start(s) + h_length(s))
            .unwrap_or(0.0)
    }

    /// Build an alignment from an `IfcPolyline` directrix. Each
    /// polyline edge becomes one horizontal Line segment plus one
    /// vertical Line segment so the unified `evaluate(station)` path
    /// works without special-casing in the processor.
    fn from_polyline(curve: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<Self> {
        let points_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("IfcPolyline missing Points".to_string()))?;
        let point_refs = points_attr
            .as_list()
            .ok_or_else(|| Error::geometry("IfcPolyline Points is not a list".to_string()))?;
        if point_refs.len() < 2 {
            return Err(Error::geometry(
                "IfcPolyline directrix needs ≥ 2 points".to_string(),
            ));
        }
        let mut pts: Vec<(f64, f64, f64)> = Vec::with_capacity(point_refs.len());
        for r in point_refs {
            let pid = r
                .as_entity_ref()
                .ok_or_else(|| Error::geometry("Polyline point is not an entity ref".to_string()))?;
            let p = decoder.decode_by_id(pid)?;
            let coords = p
                .get_list(0)
                .ok_or_else(|| Error::geometry("CartesianPoint missing Coordinates".to_string()))?;
            let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
            let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
            let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
            pts.push((x, y, z));
        }

        let mut horizontal: Vec<HSeg> = Vec::with_capacity(pts.len() - 1);
        let mut vertical: Vec<VSeg> = Vec::with_capacity(pts.len() - 1);
        let mut cum_xy = 0.0;
        for w in pts.windows(2) {
            let (x0, y0, z0) = w[0];
            let (x1, y1, z1) = w[1];
            let dx = x1 - x0;
            let dy = y1 - y0;
            let dz = z1 - z0;
            let len_xy = (dx * dx + dy * dy).sqrt();
            if len_xy < 1e-12 {
                // Pure-vertical edge — skip; would create degenerate
                // horizontal segment. The vertical segment for the
                // adjacent edges still carries the elevation change.
                continue;
            }
            let heading = dy.atan2(dx);
            horizontal.push(HSeg::Line {
                sx: x0,
                sy: y0,
                heading,
                length: len_xy,
                cum_start: cum_xy,
            });
            let gradient = dz / len_xy;
            vertical.push(VSeg::Line {
                start: cum_xy,
                length: len_xy,
                h0: z0,
                g0: gradient,
            });
            cum_xy += len_xy;
        }
        if horizontal.is_empty() {
            return Err(Error::geometry(
                "IfcPolyline directrix degenerated to zero horizontal length".to_string(),
            ));
        }
        Ok(Self { horizontal, vertical })
    }

    /// Evaluate the placement frame at the given station (cumulative
    /// distance along the horizontal alignment, in file length units).
    /// Extrapolates linearly past either end.
    pub fn evaluate(&self, station: f64) -> AlignmentFrame {
        let (x, y, heading) = self.evaluate_horizontal(station);
        let z = self.evaluate_vertical(station);
        let slope = self.evaluate_vertical_slope(station);
        let cos_h = heading.cos();
        let sin_h = heading.sin();
        // Right of travel: rotate horizontal tangent (cos h, sin h) by
        // −90° → (sin h, −cos h). Stays horizontal regardless of slope.
        let right = Vector3::new(sin_h, -cos_h, 0.0);
        let up = Vector3::new(0.0, 0.0, 1.0);
        // 3D tangent: (cos h, sin h) scaled by cos(atan slope) plus a
        // sin(atan slope) vertical component. Equivalent to taking the
        // unit-length 3D derivative of (x(s), y(s), z(s)) w.r.t. station.
        let inv_norm = (1.0 + slope * slope).sqrt();
        let tangent = Vector3::new(cos_h / inv_norm, sin_h / inv_norm, slope / inv_norm);
        AlignmentFrame {
            origin: Point3::new(x, y, z),
            right,
            up,
            tangent,
        }
    }

    /// Cant (roll about the 3D tangent) at the given station, in
    /// radians. Stable stub that always returns 0: the parser does not
    /// traverse the off-axis `IfcAlignment2DCant` relationship, so no
    /// cant is ever authored on the curve. Kept as the seam the
    /// `SectionedSolidHorizontalProcessor` reads (its cross-section roll
    /// step is a no-op while this returns 0) so cant can be wired later
    /// without touching the processor.
    pub fn cant_angle(&self, _station: f64) -> f64 {
        0.0
    }

    fn evaluate_vertical_slope(&self, station: f64) -> f64 {
        if self.vertical.is_empty() {
            return 0.0;
        }
        for seg in &self.vertical {
            let start = v_start(seg);
            let length = v_length(seg);
            // Require `station >= start` as well as `<= start + length`:
            // without the lower bound a station BEFORE a segment's own
            // start still satisfies the upper test and silently clamps
            // into it. The first segment covers station 0 via its own
            // `start` (0 after rebasing in `parse_vertical`).
            if station >= start - 1e-9 && station <= start + length + 1e-9 {
                let local = (station - start).max(0.0).min(length);
                return v_eval(seg, local).1;
            }
        }
        let last = self.vertical.last().unwrap();
        v_eval(last, v_length(last)).1
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
            // See `evaluate_vertical_slope`: the `station >= start` lower
            // bound stops a station before this segment from clamping
            // into it. Vertical starts are rebased to the horizontal's
            // 0-origin station axis in `parse_vertical`.
            if station >= start - 1e-9 && station <= start + length + 1e-9 {
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

/// Returns the parsed horizontal segments plus the alignment's
/// `StartDistAlong` (the base chainage at the physical start). The
/// segments are indexed by a cumulative-length station starting at 0;
/// the base is returned so `parse_vertical` can rebase the vertical
/// segments (authored as absolute chainages) onto that same axis.
fn parse_horizontal(
    h_id: u32,
    decoder: &mut EntityDecoder,
    angle_scale: f64,
) -> Result<(Vec<HSeg>, f64)> {
    let h_entity = decoder.decode_by_id(h_id)?;
    if h_entity.ifc_type != t_alignment_2d_horizontal() {
        return Err(Error::geometry(format!(
            "AlignmentCurve.Horizontal #{} is not IfcAlignment2DHorizontal",
            h_id,
        )));
    }
    // attr 0 = StartDistAlong (optional); attr 1 = Segments.
    let start_dist_along = h_entity.get_float(0).unwrap_or(0.0);
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
        // A negative or non-finite SegmentLength drives (station - cum).min(length)
        // negative and emits NaN world coordinates (sibling radius is guarded at
        // ~538). Zero-length stubs are a legitimate stationing no-op, so allow them.
        if !length.is_finite() || length < 0.0 {
            return Err(Error::geometry(format!(
                "CurveSegment #{} has negative/non-finite SegmentLength {}",
                curve_id, length
            )));
        }

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
            //   7: TransitionCurveType (enum — dispatches κ(s) profile)
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
            let kind = curve
                .get(7)
                .and_then(|v| v.as_enum())
                .map(TransitionKind::from_enum)
                .unwrap_or(TransitionKind::Clothoid);
            HSeg::Transition {
                sx,
                sy,
                heading,
                length,
                start_curv,
                end_curv,
                kind,
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
    Ok((segments, start_dist_along))
}

/// `horizontal_base` is the horizontal alignment's `StartDistAlong`.
/// Vertical segments carry their `StartDistAlong` as an absolute
/// chainage in the same domain as the horizontal alignment, whereas the
/// horizontal geometry (and the station passed to `evaluate`) is indexed
/// from 0 at the alignment's physical start. Subtracting the base puts
/// both axes on one 0-origin station axis; when `StartDistAlong == 0`
/// (the common case) this is a no-op.
fn parse_vertical(
    v_id: u32,
    decoder: &mut EntityDecoder,
    horizontal_base: f64,
) -> Result<Vec<VSeg>> {
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
        // Rebase the absolute chainage onto the horizontal's 0-origin
        // station axis (see the fn doc). No-op when `horizontal_base == 0`.
        let start = seg.get_float(3).ok_or_else(|| {
            Error::geometry(format!(
                "VerticalSegment #{} missing StartDistAlong",
                seg_id,
            ))
        })? - horizontal_base;
        let length = seg.get_float(4).ok_or_else(|| {
            Error::geometry(format!(
                "VerticalSegment #{} missing HorizontalLength",
                seg_id,
            ))
        })?;
        // Negative/non-finite length emits NaN geometry; zero is a legitimate no-op.
        if !length.is_finite() || length < 0.0 {
            return Err(Error::geometry(format!(
                "VerticalSegment #{} has negative/non-finite HorizontalLength {}",
                seg_id, length
            )));
        }
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
            // segment so the sweep at least continues sensibly through it.
            // (The horizontal sibling hard-errors on an unknown curve
            // subtype; a bad vertical profile shouldn't sink the whole
            // solid, so we degrade instead.) A degraded fallback is a
            // genuine anomaly, so warn rather than swallow it silently.
            crate::diag::diag_warn!(
                { vertical_segment = seg_id, ifc_type = %seg.ifc_type,
                  "alignment: unknown vertical segment subtype, degrading to a straight gradient" }
                else {
                    eprintln!(
                        "[ifc-lite][alignment] vertical segment #{} has unsupported subtype {}; \
                         degrading to a straight gradient segment",
                        seg_id, seg.ifc_type,
                    );
                }
            );
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
            kind,
            ..
        } => {
            // heading(s) = h₀ + κ₀·s + (κ₁-κ₀)·L · g(s/L)
            //   where g(u) is the integral of the curvature-blend
            //   profile chosen by the `TransitionKind` (see
            //   `TransitionKind::heading_integral`). x, y require
            //   ∫cos(h(s)) ds, ∫sin(h(s)) ds — no closed form except
            //   for the Clothoid (Fresnel integrals).
            //
            // Numerical integration via the composite trapezoidal rule.
            // Step density scales with arc-length traversed so the
            // sample interval is roughly constant per metre, with a
            // minimum of 16 samples for stability.
            let n = ((s.abs() * 0.5).ceil() as usize).max(16).min(4096);
            let ds = s / n as f64;
            let mut x = *sx;
            let mut y = *sy;
            let mut prev_cos = heading.cos();
            let mut prev_sin = heading.sin();
            for i in 1..=n {
                let u = i as f64 * ds;
                let h = *heading
                    + start_curv * u
                    + (end_curv - start_curv) * length * kind.heading_integral(u / length);
                let cs = h.cos();
                let sn = h.sin();
                x += 0.5 * ds * (prev_cos + cs);
                y += 0.5 * ds * (prev_sin + sn);
                prev_cos = cs;
                prev_sin = sn;
            }
            let final_h = *heading
                + start_curv * s
                + (end_curv - start_curv) * length * kind.heading_integral(s / length);
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

    /// Base placement frame on a straight directrix: right = (0, -1, 0),
    /// up = (0, 0, 1). `cant_angle` is a stable 0 stub (cant is not
    /// wired through the parser), so the processor's roll step is a
    /// no-op at every station.
    #[test]
    fn base_frame_axes_and_cant_stub() {
        // Straight directrix along +X, no slope.
        let curve = AlignmentCurve {
            horizontal: vec![HSeg::Line {
                sx: 0.0,
                sy: 0.0,
                heading: 0.0,
                length: 100.0,
                cum_start: 0.0,
            }],
            vertical: vec![],
        };
        let frame = curve.evaluate(50.0);
        assert!((frame.right.x).abs() < 1e-9);
        assert!((frame.right.y + 1.0).abs() < 1e-9);
        assert!((frame.up.z - 1.0).abs() < 1e-9);
        // Cant is a fixed-0 stub regardless of station.
        assert!(curve.cant_angle(50.0).abs() < 1e-9);
        assert!(curve.cant_angle(150.0).abs() < 1e-9);
    }

    /// `from_polyline` builds a piecewise-linear directrix. Each edge
    /// becomes one horizontal Line segment + one vertical Line segment;
    /// `evaluate(station)` walks them in order.
    #[test]
    fn polyline_directrix_evaluates_piecewise() {
        // Build a 3-point polyline directly (we test the construction
        // logic, not the parsing — that's covered by integration tests).
        // Path: (0,0,0) → (10, 0, 1) → (10, 10, 2)
        // Edge 1: heading 0, length 10, gradient 0.1
        // Edge 2: heading π/2, length 10, gradient 0.1
        let curve = AlignmentCurve {
            horizontal: vec![
                HSeg::Line {
                    sx: 0.0,
                    sy: 0.0,
                    heading: 0.0,
                    length: 10.0,
                    cum_start: 0.0,
                },
                HSeg::Line {
                    sx: 10.0,
                    sy: 0.0,
                    heading: std::f64::consts::FRAC_PI_2,
                    length: 10.0,
                    cum_start: 10.0,
                },
            ],
            vertical: vec![
                VSeg::Line {
                    start: 0.0,
                    length: 10.0,
                    h0: 0.0,
                    g0: 0.1,
                },
                VSeg::Line {
                    start: 10.0,
                    length: 10.0,
                    h0: 1.0,
                    g0: 0.1,
                },
            ],
        };
        // Mid-point of edge 1: station 5.
        let f1 = curve.evaluate(5.0);
        assert!((f1.origin.x - 5.0).abs() < 1e-9);
        assert!((f1.origin.y).abs() < 1e-9);
        assert!((f1.origin.z - 0.5).abs() < 1e-9);
        // Mid-point of edge 2: station 15.
        let f2 = curve.evaluate(15.0);
        assert!((f2.origin.x - 10.0).abs() < 1e-9);
        assert!((f2.origin.y - 5.0).abs() < 1e-9);
        assert!((f2.origin.z - 1.5).abs() < 1e-9);
    }

    #[test]
    fn transition_kind_heading_integral_normalised() {
        // g(0) = 0, g(1) ∈ [0.4, 0.6] (depends on profile — all the
        // smoothstep-like profiles have ½ for the integral at the
        // midpoint, and the clothoid has ½ exactly).
        for kind in [
            TransitionKind::Clothoid,
            TransitionKind::Bloss,
            TransitionKind::Cosine,
            TransitionKind::Sine,
            TransitionKind::CubicParabola,
            TransitionKind::BiquadraticParabola,
        ] {
            assert!(kind.heading_integral(0.0).abs() < 1e-12, "{:?}", kind);
            let mid = kind.heading_integral(0.5);
            assert!(mid > 0.0 && mid < 0.5, "{:?} mid={}", kind, mid);
            // Clothoid: ½ · u² → ½ · 1 = ½ at u=1.
            // Bloss / others: each peaks below ½ as a smooth blend.
            let end = kind.heading_integral(1.0);
            assert!(end > 0.0 && end < 1.0, "{:?} end={}", kind, end);
        }
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

    /// Regression: an alignment whose `IfcAlignment2DHorizontal.StartDistAlong`
    /// is a nonzero chainage (1000) must keep its horizontal and vertical
    /// evaluation in the same station domain. The horizontal geometry is
    /// indexed from station 0, but the vertical segment's `StartDistAlong`
    /// is authored as the absolute chainage 1000; without rebasing the two
    /// axes desync and the vertical lookup clamps to the segment's start
    /// height everywhere.
    ///
    /// Physical setup: a 100 m straight along +X, rising at grade 0.1 from
    /// height 50. At the halfway station the horizontal position is x = 50,
    /// so the elevation must be the halfway grade value 50 + 0.1·50 = 55.
    ///
    /// Pre-fix (no rebasing) the vertical segment sits at station 1000 while
    /// the input station is 50, so `evaluate_vertical(50)` clamped into it
    /// and returned the start height 50 — disagreeing with the horizontal
    /// axis about where "halfway" is. This assertion fails on main.
    #[test]
    fn nonzero_start_dist_along_rebases_vertical_to_horizontal() {
        let content = "\
ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
#10=IFCCARTESIANPOINT((0.,0.));
#11=IFCLINESEGMENT2D(#10,0.,100.);
#12=IFCALIGNMENT2DHORIZONTALSEGMENT($,$,$,#11);
#13=IFCALIGNMENT2DHORIZONTAL(1000.,(#12));
#14=IFCALIGNMENT2DVERSEGLINE($,$,$,1000.,100.,50.,0.1);
#15=IFCALIGNMENT2DVERTICAL((#14));
#16=IFCALIGNMENTCURVE(#13,#15,$);
ENDSEC;
END-ISO-10303-21;
";
        let entity_index = ifc_lite_core::build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);
        let directrix = decoder.decode_by_id(16).expect("decode IfcAlignmentCurve");
        let curve = AlignmentCurve::parse(&directrix, &mut decoder)
            .expect("parse alignment")
            .expect("directrix recognised as alignment");

        // Station 0 (physical start): x = 0, z = start height 50.
        let f0 = curve.evaluate(0.0);
        assert!((f0.origin.x - 0.0).abs() < 1e-6, "start x = {}", f0.origin.x);
        assert!((f0.origin.z - 50.0).abs() < 1e-6, "start z = {}", f0.origin.z);

        // Station 50 (halfway): horizontal x = 50, so elevation must be
        // 50 + 0.1·50 = 55. On main this returns 50 (clamped) and fails.
        let f_mid = curve.evaluate(50.0);
        assert!((f_mid.origin.x - 50.0).abs() < 1e-6, "mid x = {}", f_mid.origin.x);
        assert!(
            (f_mid.origin.z - 55.0).abs() < 1e-6,
            "mid z = {} (expected 55; main desyncs vertical and returns ~50)",
            f_mid.origin.z,
        );

        // Station 100 (physical end): x = 100, z = 60.
        let f_end = curve.evaluate(100.0);
        assert!((f_end.origin.x - 100.0).abs() < 1e-6, "end x = {}", f_end.origin.x);
        assert!((f_end.origin.z - 60.0).abs() < 1e-6, "end z = {}", f_end.origin.z);
    }

    /// A negative SegmentLength drives (station - cum).min(length) negative and
    /// emits NaN world coordinates. It must be rejected as an Err at parse time.
    /// (Zero-length stubs stay legal; only negative/non-finite is rejected.)
    #[test]
    fn negative_segment_length_errors_not_nan() {
        let content = "\
ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
#10=IFCCARTESIANPOINT((0.,0.));
#11=IFCLINESEGMENT2D(#10,0.,-100.);
#12=IFCALIGNMENT2DHORIZONTALSEGMENT($,$,$,#11);
#13=IFCALIGNMENT2DHORIZONTAL(0.,(#12));
#14=IFCALIGNMENT2DVERSEGLINE($,$,$,0.,100.,50.,0.1);
#15=IFCALIGNMENT2DVERTICAL((#14));
#16=IFCALIGNMENTCURVE(#13,#15,$);
ENDSEC;
END-ISO-10303-21;
";
        let entity_index = ifc_lite_core::build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);
        let directrix = decoder.decode_by_id(16).expect("decode IfcAlignmentCurve");
        assert!(AlignmentCurve::parse(&directrix, &mut decoder).is_err());
    }
}
