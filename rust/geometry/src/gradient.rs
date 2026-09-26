// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Vertical profile of an IFC4x3 `IfcGradientCurve`: elevation and grade
//! as a function of horizontal station.
//!
//! `IfcGradientCurve.Segments` are `IfcCurveSegment`s laid out in the
//! (distance-along, height) plane. Each segment's `Placement`
//! (`IfcAxis2Placement2D`) already carries everything needed to evaluate
//! the profile without walking the parent curve's own parameterisation:
//!
//! - `Location` = (start station, start height)
//! - `RefDirection` = start grade direction (dx, dz) → grade = dz / dx
//!
//! Where a following segment exists, its start station and grade close the
//! current segment. Some exports include a final zero-length marker; a final
//! circular segment can instead use its own radius and length. The
//! `ParentCurve` picks the shape between the two ends:
//!
//! - `IfcLine` → constant grade
//! - `IfcCircle` → circular arc tangent to both grades (exact)
//! - `IfcPolynomialCurve` → a parabola tangent to both authored grades;
//!   unsupported parent types leave the profile unparsed rather than
//!   fabricating a curve
//!
//! Before a first segment the profile is flat-extrapolated from its start;
//! past the last segment it continues on its end grade. A final circular
//! segment is evaluated through its authored radius and arc length.

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

#[derive(Debug, Clone, Copy, PartialEq)]
enum Shape {
    Line,
    Circular,
    Parabolic,
}

#[derive(Debug, Clone, Copy)]
struct Segment {
    start: f64,
    height: f64,
    grade: f64,
    shape: Shape,
    length: f64,
    radius: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct GradientProfile {
    segments: Vec<Segment>,
}

impl GradientProfile {
    /// Authored station of the first vertical segment. Horizontal curve
    /// evaluation starts at local station zero, while this profile may use
    /// an absolute chainage such as 1000 m.
    pub(crate) fn first_station(&self) -> f64 {
        self.segments[0].start
    }

    /// Parse the vertical profile of an `IfcGradientCurve`. `None` when the
    /// entity is not a gradient curve or carries no usable segment.
    pub fn from_curve(curve: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<Self> {
        if curve.ifc_type != IfcType::IfcGradientCurve {
            return None;
        }
        let mut segments = Vec::new();
        for seg_id in curve.get_refs(0)? {
            let Ok(seg) = decoder.decode_by_id(seg_id) else { continue };
            segments.push(parse_segment(&seg, decoder)?);
        }
        if segments.is_empty() {
            return None;
        }
        segments.sort_by(|a, b| a.start.total_cmp(&b.start));
        if segments.last().is_some_and(|s| s.shape == Shape::Parabolic && s.length.abs() > 1e-9) {
            return None; // No end grade from which to determine its curvature.
        }
        Some(Self { segments })
    }

    /// (elevation, grade dz/dx) at horizontal `station`.
    pub fn evaluate(&self, station: f64) -> (f64, f64) {
        let first = self.segments[0];
        if station <= first.start {
            return (first.height + first.grade * (station - first.start), first.grade);
        }
        // Segments are sorted at parse time. A long alignment may evaluate
        // this profile at every metre while building its 3D arc-length map.
        let i = self.segments.partition_point(|s| s.start <= station).saturating_sub(1);
        let seg = self.segments[i];
        let u = station - seg.start;
        let Some(next) = self.segments.get(i + 1) else {
            return match (seg.shape, seg.radius) {
                (Shape::Circular, Some(radius)) if seg.length.abs() > 1e-9 => {
                    let signed_radius = radius.copysign(seg.length);
                    let start_angle = seg.grade.atan();
                    let end_angle = start_angle + seg.length.abs() / signed_radius;
                    let end_station = signed_radius * (end_angle.sin() - start_angle.sin());
                    let (height, grade) = circular_from_radius(
                        seg.height, seg.grade, signed_radius, u.min(end_station),
                    );
                    if u > end_station {
                        (height + grade * (u - end_station), grade)
                    } else {
                        (height, grade)
                    }
                }
                // A final parabola has no end grade here. We cannot infer its
                // curvature from the placement alone, so parsing rejects it.
                _ => (seg.height + seg.grade * u, seg.grade),
            };
        };
        let length = next.start - seg.start;
        if length <= 1e-9 {
            return (seg.height, seg.grade);
        }
        match seg.shape {
            Shape::Line => (seg.height + seg.grade * u, seg.grade),
            Shape::Parabolic => parabolic(seg.height, seg.grade, next.grade, length, u),
            Shape::Circular => circular(seg.height, seg.grade, next.grade, length, u),
        }
    }

    pub(crate) fn station_breaks(&self) -> impl Iterator<Item = f64> + '_ {
        self.segments.iter().map(|s| s.start)
    }
}

fn parse_segment(seg: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<Segment> {
    if seg.ifc_type != IfcType::IfcCurveSegment {
        return None;
    }
    // IfcCurveSegment: 0 Transition, 1 Placement, 2 SegmentStart,
    //                  3 SegmentLength, 4 ParentCurve.
    let placement = decoder.decode_by_id(seg.get_ref(1)?).ok()?;
    let location = decoder.decode_by_id(placement.get_ref(0)?).ok()?;
    let coords = location.get_list(0)?;
    let start = coords.first()?.as_float()?;
    let height = coords.get(1)?.as_float()?;

    // RefDirection defaults to +X (level) when omitted.
    let grade = match placement.get_ref(1).and_then(|id| decoder.decode_by_id(id).ok()) {
        Some(dir) => {
            let ratios = dir.get_list(0)?;
            let dx = ratios.first()?.as_float()?;
            let dz = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
            if dx.abs() < 1e-12 {
                return None; // vertical tangent: not a valid grade
            }
            dz / dx
        }
        None => 0.0,
    };

    let parent = decoder.decode_by_id(seg.get_ref(4)?).ok()?;
    let (shape, radius) = match parent.ifc_type {
        IfcType::IfcLine => (Shape::Line, None),
        IfcType::IfcCircle => (Shape::Circular, Some(parent.get_float(1)?)),
        IfcType::IfcPolynomialCurve if is_vertical_parabola(&parent) => (Shape::Parabolic, None),
        _ => return None,
    };
    let length = seg.get_float(3)?;
    Some(Segment { start, height, grade, shape, length, radius })
}

/// The grade-interpolation formula is exact only when X is affine in the
/// curve parameter and Y is at most quadratic. Higher-order polynomial
/// parents need their own evaluator.
fn is_vertical_parabola(parent: &DecodedEntity) -> bool {
    let Some(x) = parent.get_list(1) else { return false };
    let Some(y) = parent.get_list(2) else { return false };
    x.len() == 2 && x.iter().all(|v| v.as_float().is_some())
        && x[1].as_float().is_some_and(|v| v.abs() > 1e-12)
        && (2..=3).contains(&y.len()) && y.iter().all(|v| v.as_float().is_some())
}

fn circular_from_radius(h0: f64, g0: f64, signed_radius: f64, u: f64) -> (f64, f64) {
    let angle0 = g0.atan();
    let sine = (angle0.sin() + u / signed_radius).clamp(-1.0, 1.0);
    let cosine = (1.0 - sine * sine).sqrt();
    (h0 + signed_radius * (angle0.cos() - cosine), sine / cosine)
}

fn parabolic(h0: f64, g0: f64, g1: f64, length: f64, u: f64) -> (f64, f64) {
    let k = (g1 - g0) / length;
    (h0 + g0 * u + 0.5 * k * u * u, g0 + k * u)
}

/// Arc tangent to grade `g0` at the start and `g1` after `length`
/// horizontal metres. With θ the tangent angle, x(θ) = R(sin θ − sin θ0)
/// and z(θ) = −R(cos θ − cos θ0), R = length / (sin θ1 − sin θ0) (signed:
/// positive = sag / concave up).
fn circular(h0: f64, g0: f64, g1: f64, length: f64, u: f64) -> (f64, f64) {
    let (s0, c0) = g0.atan().sin_cos();
    let s1 = g1.atan().sin();
    if (s1 - s0).abs() < 1e-12 {
        return (h0 + g0 * u, g0);
    }
    let r = length / (s1 - s0);
    let s = (s0 + u / r).clamp(-1.0, 1.0);
    let c = (1.0 - s * s).sqrt();
    (h0 - r * (c - c0), s / c)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(ifc: &str, id: u32) -> GradientProfile {
        let index = ifc_lite_core::build_entity_index(ifc);
        let mut decoder = EntityDecoder::with_index(ifc, index);
        let curve = decoder.decode_by_id(id).unwrap();
        GradientProfile::from_curve(&curve, &mut decoder).expect("parse gradient")
    }

    /// Abridged from the buildingSMART "Viadotto Acerno" bridge: constant
    /// grade, an R = 8000 crest arc, constant grade, closing marker.
    const ACERNO: &str = r#"DATA;
#1=IFCDIRECTION((1.,0.));
#2=IFCVECTOR(#1,1.);
#3=IFCCARTESIANPOINT((0.,0.));
#4=IFCLINE(#3,#2);
#5=IFCAXIS2PLACEMENT2D(#3,$);
#6=IFCCIRCLE(#5,8000.);
#10=IFCCARTESIANPOINT((0.,55.3272130954399));
#11=IFCDIRECTION((9.99915467899166E-1,-1.30021942760379E-2));
#12=IFCAXIS2PLACEMENT2D(#10,#11);
#13=IFCCURVESEGMENT(.CONTINUOUS.,#12,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(134.07),#4);
#20=IFCCARTESIANPOINT((134.059288865966,53.5840008197099));
#21=IFCDIRECTION((9.99915467899166E-1,-1.30021942760379E-2));
#22=IFCAXIS2PLACEMENT2D(#20,#21);
#23=IFCCURVESEGMENT(.CONTSAMEGRADIENT.,#22,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(38.3),#6);
#30=IFCCARTESIANPOINT((172.359870103523,53.1776610240199));
#31=IFCDIRECTION((9.99966254946E-1,-8.21489559836E-3));
#32=IFCAXIS2PLACEMENT2D(#30,#31);
#33=IFCCURVESEGMENT(.CONTSAMEGRADIENT.,#32,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(176.48),#4);
#40=IFCCARTESIANPOINT((348.841611735963,51.7278330195199));
#41=IFCDIRECTION((9.99966254946E-1,-8.21489559836E-3));
#42=IFCAXIS2PLACEMENT2D(#40,#41);
#43=IFCCURVESEGMENT(.DISCONTINUOUS.,#42,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(0.),#4);
#50=IFCGRADIENTCURVE((#13,#23,#33,#43),.F.,$,$);
ENDSEC;
"#;

    #[test]
    fn hits_authored_heights_at_segment_starts() {
        let p = profile(ACERNO, 50);
        for (station, height) in [
            (0.0, 55.3272130954399),
            (134.059288865966, 53.5840008197099),
            (172.359870103523, 53.1776610240199),
            (348.841611735963, 51.7278330195199),
        ] {
            let (h, _) = p.evaluate(station);
            assert!((h - height).abs() < 1e-3, "station {station}: {h} vs {height}");
        }
    }

    #[test]
    fn arc_ends_on_the_next_segment_tangentially() {
        let p = profile(ACERNO, 50);
        // Just before the arc/line junction the arc's height and grade must
        // agree with the following line's start (continuity the file declares).
        let (h, g) = p.evaluate(172.359870103523 - 1e-6);
        assert!((h - 53.1776610240199).abs() < 2e-3, "arc end height {h}");
        assert!((g - -8.21517280533015E-3).abs() < 1e-5, "arc end grade {g}");
    }

    #[test]
    fn constant_grade_is_linear_and_extrapolates() {
        let p = profile(ACERNO, 50);
        let (h, g) = p.evaluate(67.0);
        assert!((h - (55.3272130954399 - 0.0130032934717528 * 67.0)).abs() < 1e-6);
        assert!((g - -0.0130032934717528).abs() < 1e-9);
        // Past the closing marker (10 m on) its grade continues.
        let (h_end, _) = p.evaluate(358.841611735963);
        assert!((h_end - (51.7278330195199 - 8.21517280533015E-3 * 10.0)).abs() < 1e-4, "{h_end}");
    }

    #[test]
    fn non_gradient_curve_is_none() {
        let ifc = "DATA;\n#1=IFCCARTESIANPOINT((0.,0.));\n#2=IFCPOLYLINE((#1,#1));\nENDSEC;\n";
        let index = ifc_lite_core::build_entity_index(ifc);
        let mut decoder = EntityDecoder::with_index(ifc, index);
        let e = decoder.decode_by_id(2).unwrap();
        assert!(GradientProfile::from_curve(&e, &mut decoder).is_none());
    }

    #[test]
    fn final_circle_keeps_curving_without_closing_marker() {
        // #5327: IfcGradientCurve need not have a trailing zero-length
        // segment. The final circle's own radius and length still define
        // its elevation and tangent.
        let ifc = "DATA;\n#1=IFCCARTESIANPOINT((0.,0.));\n#2=IFCAXIS2PLACEMENT2D(#1,$);\n#3=IFCCIRCLE(#2,100.);\n#4=IFCCURVESEGMENT(.CONTINUOUS.,#2,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(20.),#3);\n#5=IFCGRADIENTCURVE((#4),.F.,$,$);\nENDSEC;";
        let p = profile(ifc, 5);
        let (h, grade) = p.evaluate(10.0);
        assert!((h - (100.0 - (10000.0_f64 - 100.0).sqrt())).abs() < 1e-8);
        assert!((grade - 10.0 / (10000.0_f64 - 100.0).sqrt()).abs() < 1e-8);
    }

    #[test]
    fn unknown_parent_does_not_silently_become_parabola() {
        // #5327: shape inference from adjacent grades only applies to
        // known profile parents. An arbitrary parent must not fabricate
        // an elevation profile.
        let ifc = "DATA;\n#1=IFCCARTESIANPOINT((0.,0.));\n#2=IFCAXIS2PLACEMENT2D(#1,$);\n#3=IFCCLOTHOID(#2,100.);\n#4=IFCCURVESEGMENT(.CONTINUOUS.,#2,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(20.),#3);\n#5=IFCGRADIENTCURVE((#4),.F.,$,$);\nENDSEC;";
        let index = ifc_lite_core::build_entity_index(ifc);
        let mut decoder = EntityDecoder::with_index(ifc, index);
        let curve = decoder.decode_by_id(5).unwrap();
        assert!(GradientProfile::from_curve(&curve, &mut decoder).is_none());
    }
}
