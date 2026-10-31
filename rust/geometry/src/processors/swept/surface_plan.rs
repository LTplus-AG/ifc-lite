// SPDX-License-Identifier: MPL-2.0
//! Owned profile/placed-directrix inputs for the sweep. The section roll
//! follows the solid's reference (ISO 10303-42) when it is one we can
//! evaluate, and the rotation-minimising frame otherwise.
use super::super::disk::build_tube_rmf;
use super::sweep_profile_along_frames;
use crate::{profile::Profile2D, Mesh, Point3, Result, Vector3};

/// What fixes the roll of the section about the directrix tangent, already in
/// the placed (Position-applied) frame of `points`.
///
/// ISO 10303-42 (`surface_curve_swept_area_solid`, repeated in the IFC4 /
/// IFC4.3 documentation of `IfcSurfaceCurveSweptAreaSolid`): the section is
/// placed by a transformation whose Axis1 is the normal N of the
/// ReferenceSurface at the directrix point and whose Axis3 is the directrix
/// tangent t; Axis2 = Axis3 x Axis1. `IfcFixedReferenceSweptAreaSolid` uses
/// the FixedReference projected onto the plane normal to t as Axis1.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum SectionRoll {
    /// The ReferenceSurface normal at each directrix sample, one per point
    /// (`IfcSurfaceOfLinearExtrusion`, see [`extrusion_normals`]).
    Normals(Vec<Vector3<f64>>),
    /// `IfcPlane` normal, or the `FixedReference` direction: Axis1 is this
    /// vector with its component along t removed.
    Projected(Vector3<f64>),
}

#[derive(Debug, Clone)]
pub(crate) struct SurfaceCurveSweepPlan {
    pub(super) regions: Vec<Profile2D>,
    pub(super) points: Vec<Point3<f64>>,
    pub(super) entity_id: u32,
    /// `None`: no reference we can evaluate (absent, or a surface type not
    /// handled yet); the rotation-minimising frame is used, as before.
    pub(super) roll: Option<SectionRoll>,
}

/// Below this length a vector gives no usable direction (a zero-length curve
/// segment, or a reference parallel to the tangent).
const ROLL_DEGENERATE_EPS: f64 = 1e-9;

/// The normal of an `IfcSurfaceOfLinearExtrusion` S(u, v) = C(u) + v·D at each
/// directrix sample: dS/du x dS/dv = C'(u) x D. The sign follows the
/// SweptCurve's own direction, not the directrix's, so a directrix that runs
/// against the SweptCurve (a separately reversed curve, or `SenseAgreement`
/// .F.) keeps Axis1 and only flips Axis3 (and with it Axis2), as the ISO
/// definition requires. C'(u) is the direction of the `curve` segment nearest
/// the sample, measured across D, since the directrix may lie at any height v
/// on the surface. `None` if D or every segment is degenerate.
pub(super) fn extrusion_normals(
    curve: &[Point3<f64>],
    extruded_direction: &Vector3<f64>,
    points: &[Point3<f64>],
) -> Option<Vec<Vector3<f64>>> {
    let d = extruded_direction.try_normalize(ROLL_DEGENERATE_EPS)?;
    let across = |p: &Point3<f64>| p.coords - d * d.dot(&p.coords);
    let segments: Vec<(Vector3<f64>, Vector3<f64>)> = curve
        .windows(2)
        .filter_map(|w| {
            let (a, b) = (across(&w[0]), across(&w[1]));
            // A zero-length (or non-finite) step has no normal: skip it.
            let normal = (b - a).cross(&d).try_normalize(ROLL_DEGENERATE_EPS)?;
            normal.iter().all(|c| c.is_finite()).then_some((a, b - a))
        })
        .collect();
    if segments.is_empty() {
        return None;
    }
    let normals = points
        .iter()
        .map(|p| {
            let q = across(p);
            let mut best = (f64::INFINITY, segments[0].1);
            for (a, step) in &segments {
                let t = ((q - a).dot(step) / step.norm_squared()).clamp(0.0, 1.0);
                let distance = (q - (a + step * t)).norm();
                if distance < best.0 {
                    best = (distance, *step);
                }
            }
            best.1.cross(&d).normalize()
        })
        .collect();
    Some(normals)
}

/// Per-sample (Axis1, Axis2) for the reference roll, with the same handedness
/// as the RMF (perp2 = t x perp1), so `sweep_profile_along_frames` winds the
/// same way. `None` when the reference is unusable at any sample (parallel to
/// the tangent there, or a normal count that does not match the samples): the
/// whole sweep then keeps the RMF, so the frame never switches convention
/// mid-sweep and twists the section.
pub(super) fn reference_frames(
    roll: &SectionRoll,
    tangents: &[Vector3<f64>],
) -> Option<(Vec<Vector3<f64>>, Vec<Vector3<f64>>)> {
    if let SectionRoll::Normals(normals) = roll {
        if normals.len() != tangents.len() {
            return None;
        }
    }
    let mut perp1s = Vec::with_capacity(tangents.len());
    let mut perp2s = Vec::with_capacity(tangents.len());
    for (i, t) in tangents.iter().enumerate() {
        let reference = match roll {
            SectionRoll::Normals(normals) => normals[i],
            SectionRoll::Projected(r) => *r,
        };
        let axis1 = (reference - t * t.dot(&reference)).try_normalize(ROLL_DEGENERATE_EPS)?;
        perp1s.push(axis1);
        perp2s.push(t.cross(&axis1).normalize());
    }
    Some((perp1s, perp2s))
}

impl SurfaceCurveSweepPlan {
    pub(crate) fn evaluate(&self) -> Result<Mesh> {
        // --- Sweep the profile along the placed directrix --------------------------
        let (tangents, rmf1, rmf2) = build_tube_rmf(&self.points);
        let (perp1s, perp2s) = self
            .roll
            .as_ref()
            .and_then(|roll| reference_frames(roll, &tangents))
            .unwrap_or((rmf1, rmf2));
        let placed = self
            .regions
            .iter()
            .map(crate::profiles::region_points)
            .sum::<usize>()
            * self.points.len();
        // Base already swept holes here; only further composite areas are new.
        crate::profiles::check_sweep_vertices(placed, self.regions.len() > 1, self.entity_id)?;
        if let [region] = self.regions.as_slice() {
            return sweep_profile_along_frames(region, &self.points, &perp1s, &perp2s);
        }
        let mut mesh = Mesh::new();
        for region in &self.regions {
            mesh.merge(&sweep_profile_along_frames(
                region,
                &self.points,
                &perp1s,
                &perp2s,
            )?);
        }
        Ok(mesh)
    }
}

#[cfg(test)]
#[path = "surface_plan_tests.rs"]
mod tests;
