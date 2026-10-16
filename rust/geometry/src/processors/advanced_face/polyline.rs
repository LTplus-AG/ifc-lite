// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Standalone curve -> polyline sampler used as the surface-of-revolution generator profile.

use crate::{scale_segments, Point3, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

use super::conics::{read_axis2_placement_frame, sample_circle_edge_curve};
use super::curves::{sample_bspline_curve_polyline, sample_bspline_edge_curve, Refused};

/// Sample points along a curve in 3D. Currently handles `IfcLine`, `IfcCircle`,
/// `IfcTrimmedCurve` and `IfcBSplineCurveWithKnots`. Returns a polyline that
/// approximates the curve. Used as the generator profile for surfaces of
/// revolution. A refused curve (see [`try_sample_curve_polyline`]) yields no
/// points, like an unsupported one.
pub(super) fn sample_curve_polyline(
    curve: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Vec<Point3<f64>> {
    try_sample_curve_polyline(curve, decoder, quality).unwrap_or_default()
}

/// [`sample_curve_polyline`], telling a curve whose authored points do not
/// resolve (`Err(Refused)`, #7687 PROC-S21) apart from one this sampler does
/// not support (`Ok` and empty). A composite edge refuses its loop on the
/// former and bridges the latter, as it always has.
pub(super) fn try_sample_curve_polyline(
    curve: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<Vec<Point3<f64>>, Refused> {
    let mut visited = std::collections::HashSet::new();
    sample_curve_polyline_guarded(curve, decoder, quality, 0, &mut visited)
}

/// Longest `IfcTrimmedCurve.BasisCurve` chain the sampler will follow.
///
/// The visited set below stops CYCLES; this stops LENGTH. They are not
/// interchangeable: a chain of 200k distinct trimmed curves makes every
/// `visited.insert` succeed, so the set never fires and the recursion consumes
/// one stack frame per file-supplied entity until the process aborts. A file
/// with no cycle at all reaches the same crash, and a chain is as easy to
/// author as a loop.
///
/// 32 matches the mapped-item bound used elsewhere for file-driven chains.
/// Real trimming nests one or two levels.
const MAX_BASIS_CURVE_DEPTH: u32 = 32;

/// `IfcTrimmedCurve.BasisCurve` may itself be an `IfcTrimmedCurve`, and the
/// reference comes from the file, so `#10=IFCTRIMMEDCURVE(#10,...)` — a single
/// self-referential entity — recursed forever. A Rust stack overflow ABORTS
/// rather than raising a catchable panic, so nothing downstream could turn it
/// into a load error, and this is reached by any `IfcAdvancedBrep` with a
/// composite edge curve (#2866).
///
/// Both a visited set and a depth cap, because they bound different things:
/// the set stops cycles (and any future fan-out, which the single tail call
/// here does not have today but which nothing enforces), the cap stops a long
/// ACYCLIC chain, where every insert succeeds and the set never fires.
///
/// It is global to one top-level sample, not path-scoped: the result is a pure
/// function of (curve, quality), so a curve already being sampled cannot yield
/// a different polyline further down, and the delegation returns rather than
/// accumulating.
fn sample_curve_polyline_guarded(
    curve: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    depth: u32,
    visited: &mut std::collections::HashSet<u32>,
) -> Result<Vec<Point3<f64>>, Refused> {
    if depth >= MAX_BASIS_CURVE_DEPTH || !visited.insert(curve.id) {
        return Ok(Vec::new());
    }
    use std::f64::consts::TAU;
    let kind = curve.ifc_type.as_str().to_uppercase();
    // The rational variant shares attributes 0-7 with the plain one; sampling
    // it unweighted beats dropping the curve entirely.
    if kind == "IFCBSPLINECURVEWITHKNOTS" || kind == "IFCRATIONALBSPLINECURVEWITHKNOTS" {
        return sample_bspline_curve_polyline(curve, decoder, quality);
    }
    if kind == "IFCLINE" {
        // IfcLine: 0=Pnt, 1=Dir(IfcVector). Treat as segment [Pnt, Pnt+Dir·magnitude].
        let pnt = curve
            .get(0)
            .and_then(|a| decoder.resolve_ref(a).ok().flatten())
            .and_then(|p| {
                let coords = p.get(0).and_then(|v| v.as_list())?;
                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                Some(Point3::new(x, y, z))
            });
        let (dir, mag) = curve
            .get(1)
            .and_then(|a| decoder.resolve_ref(a).ok().flatten())
            .map(|v| {
                let direction = v.get(0).and_then(|a| decoder.resolve_ref(a).ok().flatten());
                let magnitude = v.get(1).and_then(|a| a.as_float()).unwrap_or(1.0);
                let dir = direction
                    .and_then(|d| {
                        let coords = d.get(0).and_then(|v| v.as_list())?;
                        let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                        let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                        let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                        Some(nalgebra::Vector3::new(x, y, z))
                    })
                    .and_then(|v| v.try_normalize(1e-12))
                    .unwrap_or_else(|| nalgebra::Vector3::new(1.0, 0.0, 0.0));
                (dir, magnitude)
            })
            .unwrap_or_else(|| (nalgebra::Vector3::new(1.0, 0.0, 0.0), 1.0));
        let start = pnt.unwrap_or_else(|| Point3::new(0.0, 0.0, 0.0));
        return Ok(vec![start, start + dir * mag]);
    }
    if kind == "IFCCIRCLE" {
        let radius = curve.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
        if radius <= 0.0 {
            return Ok(Vec::new());
        }
        let placement = match curve.get(0).and_then(|a| decoder.resolve_ref(a).ok().flatten()) {
            Some(p) => p,
            None => return Ok(Vec::new()),
        };
        let (center, axis_z, axis_x) = read_axis2_placement_frame(&placement, decoder);
        let axis_y = axis_z.cross(&axis_x);
        let n = scale_segments(24, 8, 96, quality);
        return Ok((0..=n)
            .map(|i| {
                let a = TAU * (i as f64) / (n as f64);
                center + axis_x * (radius * a.cos()) + axis_y * (radius * a.sin())
            })
            .collect());
    }
    if kind == "IFCPOLYLINE" {
        // IfcPolyline: 0=Points (list of IfcCartesianPoint)
        let refs = match curve.get(0).and_then(|a| a.as_list()) {
            Some(r) => r,
            None => return Ok(Vec::new()),
        };
        return polyline_points(refs, decoder);
    }
    if kind == "IFCELLIPSE" {
        // IfcEllipse: 0=Position, 1=SemiAxis1, 2=SemiAxis2. Full ellipse.
        let r1 = curve.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
        let r2 = curve.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
        if r1 <= 0.0 || r2 <= 0.0 {
            return Ok(Vec::new());
        }
        let placement = match curve.get(0).and_then(|a| decoder.resolve_ref(a).ok().flatten()) {
            Some(p) => p,
            None => return Ok(Vec::new()),
        };
        let (center, axis_z, axis_x) = read_axis2_placement_frame(&placement, decoder);
        let axis_y = axis_z.cross(&axis_x);
        let n = scale_segments(24, 8, 96, quality);
        return Ok((0..=n)
            .map(|i| {
                let a = TAU * (i as f64) / (n as f64);
                center + axis_x * (r1 * a.cos()) + axis_y * (r2 * a.sin())
            })
            .collect());
    }
    if kind == "IFCTRIMMEDCURVE" {
        // 0=BasisCurve, 1=Trim1, 2=Trim2, 3=Sense, 4=MasterRepresentation.
        let basis = match curve.get(0).and_then(|a| decoder.resolve_ref(a).ok().flatten()) {
            Some(b) => b,
            None => return Ok(Vec::new()),
        };
        let basis_kind = basis.ifc_type.as_str().to_uppercase();
        let sense = curve
            .get(3)
            .and_then(|a| a.as_enum())
            .map(|e| e == "T" || e == "TRUE")
            .unwrap_or(true);

        let mut read_trim_point = |idx: usize| -> Option<Point3<f64>> {
            let list = curve.get(idx)?.as_list()?;
            for v in list {
                if let Some(id) = v.as_entity_ref() {
                    if let Ok(e) = decoder.decode_by_id(id) {
                        if e.ifc_type.as_str().eq_ignore_ascii_case("IFCCARTESIANPOINT") {
                            let coords = e.get(0).and_then(|a| a.as_list())?;
                            let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                            let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                            let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                            return Some(Point3::new(x, y, z));
                        }
                    }
                }
            }
            None
        };

        let p1 = read_trim_point(1);
        let p2 = read_trim_point(2);

        if basis_kind == "IFCCIRCLE" {
            if let (Some(p_start), Some(p_end)) = (p1, p2) {
                // Edge-loop callers consume `start..pre_end` and rely on the
                // *next* edge to add the end vertex. When this helper is used
                // standalone (e.g. as a surface-of-revolution generator
                // profile) we have to append the terminal point ourselves so
                // the polyline isn't truncated by one segment.
                // Per CodeRabbit feedback on PR #605.
                let mut pts =
                    sample_circle_edge_curve(&basis, &p_start, &p_end, sense, decoder, quality);
                pts.push(p_end);
                return Ok(pts);
            }
        }
        if basis_kind == "IFCBSPLINECURVEWITHKNOTS" {
            if let (Some(p_start), Some(p_end)) = (p1, p2) {
                let mut pts = sample_bspline_edge_curve(&basis, &p_start, sense, decoder, quality)?;
                pts.push(p_end);
                return Ok(pts);
            }
            if let Some(p_start) = p1 {
                return sample_bspline_edge_curve(&basis, &p_start, sense, decoder, quality);
            }
        }
        if basis_kind == "IFCLINE" {
            // A trimmed line is just the segment between its two cartesian trim
            // points. Falling through to `sample_curve_polyline(&basis)` below
            // would discard Trim1/Trim2 and sample the *raw* IfcLine, whose
            // IfcVector magnitude is a tool-emitted unit length (e.g. Revit's
            // 0.3048 = 1 ft) wholly unrelated to the trimmed extent. For a
            // surface-of-revolution generator profile that inflates the
            // revolved radius/extent ~50-70x (light-fixture #189538 hull 9.5x,
            // proxy #209435 hull 3.2x in ISSUE_159).
            if let (Some(p_start), Some(p_end)) = (p1, p2) {
                return Ok(if sense {
                    vec![p_start, p_end]
                } else {
                    vec![p_end, p_start]
                });
            }
        }
        return sample_curve_polyline_guarded(&basis, decoder, quality, depth + 1, visited);
    }
    Ok(Vec::new())
}

/// The points of an `IfcPolyline` (or any point-reference list), in order.
/// A reference that does not resolve to coordinates refuses the whole list
/// (#7687, PROC-S21): skipping it draws a polyline one vertex short.
pub(super) fn polyline_points(
    refs: &[ifc_lite_core::AttributeValue],
    decoder: &mut EntityDecoder,
) -> Result<Vec<Point3<f64>>, Refused> {
    refs.iter()
        .map(|r| {
            let point = decoder.decode_by_id(r.as_entity_ref()?).ok()?;
            let coords = point.get(0).and_then(|v| v.as_list())?;
            let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
            let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
            let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
            Some(Point3::new(x, y, z))
        })
        .collect::<Option<Vec<_>>>()
        .ok_or(Refused)
}

#[cfg(test)]
#[path = "polyline_cycle_tests.rs"]
mod polyline_cycle_tests;
