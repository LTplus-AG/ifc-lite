// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Dense sampling of a planar IFC4x3 `IfcCurveSegment` — the building block
//! of alignment `IfcCompositeCurve`s / `IfcGradientCurve` base curves.
//!
//! A curve segment is the stretch `SegmentStart .. SegmentStart +
//! SegmentLength` of its `ParentCurve` (arc-length parameterised; a
//! negative length walks the parent backwards), rigidly moved so that its
//! start point lands on `Placement.Location` and its start tangent (in the
//! direction of travel) on `Placement.RefDirection`.
//!
//! Supported parents: `IfcLine`, `IfcCircle`, `IfcClothoid` — what
//! horizontal alignments are made of. Anything else returns `None` and the
//! caller keeps its previous behaviour. Without this the composite-curve
//! walker emitted one point per segment, turning every arc into a chord:
//! on a 158 m, R = 400 m arc that is 7.8 m off the true alignment at
//! mid-arc.

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::{Point3, Vector2};

/// Maximum sample spacing along curved parents, in file length units
/// (metres for every alignment file seen so far). Keeps the chord error of
/// an R = 400 m arc below 1 mm-ish (s²/8R = 0.3 mm at 1 m).
const MAX_STEP: f64 = 1.0;
/// Upper bound on samples per segment so a pathological length can't
/// explode memory.
const MAX_SAMPLES: usize = 4096;

enum Parent {
    Line,
    Circle { radius: f64 },
    /// Signed clothoid constant A: heading(s) = s² / (2·A·|A|), so a
    /// negative A turns clockwise.
    Clothoid { a: f64 },
}

impl Parent {
    /// Point and heading at arc length `s`, in the parent's own frame
    /// (placement ignored — only relative geometry matters here).
    fn eval(&self, s: f64) -> (Vector2<f64>, f64) {
        match *self {
            Parent::Line => (Vector2::new(s, 0.0), 0.0),
            Parent::Circle { radius } => {
                let t = s / radius;
                (Vector2::new(radius * t.cos(), radius * t.sin()), t + std::f64::consts::FRAC_PI_2)
            }
            Parent::Clothoid { a } => {
                let k = 1.0 / (2.0 * a * a.abs());
                (clothoid_point(s, k), k * s * s)
            }
        }
    }

    fn curved(&self) -> bool {
        !matches!(self, Parent::Line)
    }
}

/// ∫₀ˢ (cos kt², sin kt²) dt by composite Simpson — smooth integrand, so a
/// fixed fine subdivision is accurate to far below a millimetre.
fn clothoid_point(s: f64, k: f64) -> Vector2<f64> {
    clothoid_interval(0.0, s, k)
}

/// Integrate only the interval between adjacent samples. Reintegrating from
/// zero for every point makes a long segment quadratic in its sample count.
fn clothoid_interval(from: f64, to: f64, k: f64) -> Vector2<f64> {
    let mut n = (((to - from).abs() / 0.25).ceil() as usize).clamp(2, 20_000);
    n += n % 2; // Simpson needs an even count
    let h = (to - from) / n as f64;
    let f = |t: f64| Vector2::new((k * t * t).cos(), (k * t * t).sin());
    let mut acc = f(from) + f(to);
    for i in 1..n {
        let w = if i % 2 == 1 { 4.0 } else { 2.0 };
        acc += f(from + i as f64 * h) * w;
    }
    acc * (h / 3.0)
}

fn read_parent(parent: &DecodedEntity) -> Option<Parent> {
    match parent.ifc_type {
        IfcType::IfcLine => Some(Parent::Line),
        // IfcCircle: 0 Position, 1 Radius
        IfcType::IfcCircle => parent
            .get_float(1)
            .filter(|r| *r > 1e-12)
            .map(|radius| Parent::Circle { radius }),
        // IfcClothoid: 0 Position, 1 ClothoidConstant
        IfcType::IfcClothoid => parent
            .get_float(1)
            .filter(|a| a.abs() > 1e-12)
            .map(|a| Parent::Clothoid { a }),
        _ => None,
    }
}

/// Read `IfcAxis2Placement2D/3D` → (location, heading of RefDirection in XY).
fn read_placement(placement: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<(Point3<f64>, f64)> {
    let dir_idx = match placement.ifc_type {
        IfcType::IfcAxis2Placement2D => 1,
        IfcType::IfcAxis2Placement3D => 2,
        _ => return None,
    };
    let loc = decoder.decode_by_id(placement.get_ref(0)?).ok()?;
    let c = loc.get_list(0)?;
    let origin = Point3::new(
        c.first()?.as_float()?,
        c.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
        c.get(2).and_then(|v| v.as_float()).unwrap_or(0.0),
    );
    let heading = match placement.get_ref(dir_idx).and_then(|id| decoder.decode_by_id(id).ok()) {
        Some(dir) => {
            let r = dir.get_list(0)?;
            let dx = r.first()?.as_float()?;
            let dy = r.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
            dy.atan2(dx)
        }
        None => 0.0,
    };
    Some((origin, heading))
}

/// World-space samples of an `IfcCurveSegment`, start and end included.
/// `None` when the segment or its parent curve type isn't supported.
pub(crate) fn sample_curve_segment(
    segment: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<Vec<Point3<f64>>> {
    if segment.ifc_type != IfcType::IfcCurveSegment {
        return None;
    }
    // IfcCurveSegment: 0 Transition, 1 Placement, 2 SegmentStart,
    //                  3 SegmentLength, 4 ParentCurve.
    let placement = decoder.decode_by_id(segment.get_ref(1)?).ok()?;
    let (origin, place_heading) = read_placement(&placement, decoder)?;
    let start = segment.get_float(2).unwrap_or(0.0);
    let length = segment.get_float(3)?;
    let parent_entity = decoder.decode_by_id(segment.get_ref(4)?).ok()?;
    let parent = read_parent(&parent_entity)?;

    let (p0, h0) = parent.eval(start);
    // Direction of travel: a negative length walks the parent backwards,
    // so the segment's start tangent is the parent tangent reversed.
    let travel_heading = if length < 0.0 { h0 + std::f64::consts::PI } else { h0 };
    let rot = place_heading - travel_heading;
    let (sin_r, cos_r) = rot.sin_cos();

    let n = if parent.curved() {
        ((length.abs() / MAX_STEP).ceil() as usize).clamp(1, MAX_SAMPLES)
    } else {
        1
    };
    let mut out = Vec::with_capacity(n + 1);
    let mut previous_s = start;
    let mut clothoid_position = p0;
    for i in 0..=n {
        let s = start + length * (i as f64 / n as f64);
        let position = match &parent {
            Parent::Clothoid { a } => {
                let k = 1.0 / (2.0 * a * a.abs());
                clothoid_position += clothoid_interval(previous_s, s, k);
                clothoid_position
            }
            _ => parent.eval(s).0,
        };
        previous_s = s;
        let d = position - p0;
        out.push(Point3::new(
            origin.x + cos_r * d.x - sin_r * d.y,
            origin.y + sin_r * d.x + cos_r * d.y,
            origin.z,
        ));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples(ifc: &str, id: u32) -> Vec<Point3<f64>> {
        let index = ifc_lite_core::build_entity_index(ifc);
        let mut decoder = EntityDecoder::with_index(ifc, index);
        let seg = decoder.decode_by_id(id).unwrap();
        sample_curve_segment(&seg, &mut decoder).expect("supported segment")
    }

    const HEADER: &str = "DATA;\n#1=IFCCARTESIANPOINT((0.,0.));\n#2=IFCDIRECTION((1.,0.));\n#3=IFCAXIS2PLACEMENT2D(#1,#2);\n";

    #[test]
    fn line_segment_runs_along_ref_direction() {
        let ifc = format!(
            "{HEADER}#4=IFCVECTOR(#2,1.);\n#5=IFCLINE(#1,#4);\n\
             #6=IFCCARTESIANPOINT((10.,5.));\n#7=IFCDIRECTION((0.,1.));\n#8=IFCAXIS2PLACEMENT2D(#6,#7);\n\
             #9=IFCCURVESEGMENT(.CONTINUOUS.,#8,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(20.),#5);\nENDSEC;\n"
        );
        let p = samples(&ifc, 9);
        assert!((p[0] - Point3::new(10.0, 5.0, 0.0)).norm() < 1e-9);
        assert!((p.last().unwrap() - Point3::new(10.0, 25.0, 0.0)).norm() < 1e-9);
    }

    #[test]
    fn circle_segment_follows_the_arc_not_the_chord() {
        // Quarter circle R = 100 starting at (0,0) heading +X, turning left:
        // ends at (100, 100); its midpoint is R(1−cos45°) off the chord.
        let ifc = format!(
            "{HEADER}#5=IFCCIRCLE(#3,100.);\n\
             #9=IFCCURVESEGMENT(.CONTINUOUS.,#3,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE({}),#5);\nENDSEC;\n",
            std::f64::consts::FRAC_PI_2 * 100.0
        );
        let p = samples(&ifc, 9);
        assert!((p.last().unwrap() - Point3::new(100.0, 100.0, 0.0)).norm() < 1e-6);
        let mid = p[p.len() / 2];
        let expected = Point3::new(100.0 * (std::f64::consts::FRAC_PI_4).sin(), 100.0 * (1.0 - std::f64::consts::FRAC_PI_4.cos()), 0.0);
        assert!((mid - expected).norm() < 0.05, "mid {mid:?} vs {expected:?}");
    }

    #[test]
    fn negative_circle_length_turns_right() {
        let ifc = format!(
            "{HEADER}#5=IFCCIRCLE(#3,100.);\n\
             #9=IFCCURVESEGMENT(.CONTINUOUS.,#3,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE({}),#5);\nENDSEC;\n",
            -std::f64::consts::FRAC_PI_2 * 100.0
        );
        let end = *samples(&ifc, 9).last().unwrap();
        assert!((end - Point3::new(100.0, -100.0, 0.0)).norm() < 1e-6, "{end:?}");
    }

    #[test]
    fn clothoid_matches_series_expansion() {
        // A = 100, L = 50: x ≈ L − L⁵/(40A⁴), y ≈ L³/(6A²) − L⁷/(336A⁶).
        let ifc = format!(
            "{HEADER}#5=IFCCLOTHOID(#3,100.);\n\
             #9=IFCCURVESEGMENT(.CONTINUOUS.,#3,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(50.),#5);\nENDSEC;\n"
        );
        let end = *samples(&ifc, 9).last().unwrap();
        let (l, a) = (50.0_f64, 100.0_f64);
        let x = l - l.powi(5) / (40.0 * a.powi(4));
        let y = l.powi(3) / (6.0 * a * a) - l.powi(7) / (336.0 * a.powi(6));
        assert!((end.x - x).abs() < 1e-4 && (end.y - y).abs() < 1e-4, "{end:?} vs ({x}, {y})");
    }

    #[test]
    fn clothoid_incremental_integration_preserves_nonzero_and_reverse_stations() {
        let k = 1.0 / (2.0 * 100.0_f64.powi(2));
        for (from, to) in [(25.0, 75.0), (75.0, 25.0), (-25.0, 25.0)] {
            let mut sum = Vector2::zeros();
            for i in 0..100 {
                let a = from + (to - from) * i as f64 / 100.0;
                let b = from + (to - from) * (i + 1) as f64 / 100.0;
                sum += clothoid_interval(a, b, k);
            }
            let expected = clothoid_point(to, k) - clothoid_point(from, k);
            assert!((sum - expected).norm() < 1e-6, "{from} → {to}: {sum:?} vs {expected:?}");
        }
    }
}
