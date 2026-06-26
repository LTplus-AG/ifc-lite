// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Standalone curve -> polyline sampler used as the surface-of-revolution generator profile.

use crate::{scale_segments, Point3, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

use super::bspline::{evaluate_bspline_curve, expand_knots};
use super::curves::{read_axis2_placement_3d, sample_bspline_edge_curve, sample_circle_edge_curve};

/// Sample points along a curve in 3D. Currently handles `IfcLine`, `IfcCircle`,
/// `IfcTrimmedCurve` and `IfcBSplineCurveWithKnots`. Returns a polyline that
/// approximates the curve. Used as the generator profile for surfaces of
/// revolution.
pub(super) fn sample_curve_polyline(
    curve: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Vec<Point3<f64>> {
    use std::f64::consts::TAU;
    let kind = curve.ifc_type.as_str().to_uppercase();
    if kind == "IFCBSPLINECURVEWITHKNOTS" {
        // Reuse the helper with a synthetic start; we just need the polyline.
        let mut pts = sample_bspline_edge_curve(
            curve,
            &Point3::new(0.0, 0.0, 0.0),
            true,
            decoder,
            quality,
        );
        if !pts.is_empty() {
            // Replace the synthetic start with an explicit evaluation at t_min.
            let degree = curve.get_float(0).unwrap_or(3.0) as usize;
            if let (Some(cp_list), Some(mults), Some(knot_values)) = (
                curve.get(1).and_then(|a| a.as_list()),
                curve
                    .get(6)
                    .and_then(|a| a.as_list())
                    .map(|l| l.iter().filter_map(|v| v.as_int()).collect::<Vec<_>>()),
                curve
                    .get(7)
                    .and_then(|a| a.as_list())
                    .map(|l| l.iter().filter_map(|v| v.as_float()).collect::<Vec<_>>()),
            ) {
                let cps: Vec<Point3<f64>> = cp_list
                    .iter()
                    .filter_map(|r| {
                        let id = r.as_entity_ref()?;
                        let pt = decoder.decode_by_id(id).ok()?;
                        let coords = pt.get(0)?.as_list()?;
                        let x = coords.first()?.as_float().unwrap_or(0.0);
                        let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                        let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                        Some(Point3::new(x, y, z))
                    })
                    .collect();
                if !cps.is_empty() && !mults.is_empty() && !knot_values.is_empty() {
                    let knots = expand_knots(&knot_values, &mults);
                    if knots.len() > degree {
                        let t0 = knots[degree];
                        pts[0] = evaluate_bspline_curve(t0, degree, &cps, &knots);
                        // Also append the explicit terminal endpoint so
                        // standalone polyline callers (e.g. SoR generator
                        // profiles) don't lose the last segment. Edge-loop
                        // callers tolerate the duplicate via dedup later.
                        // Per CodeRabbit feedback on PR #605.
                        let t_max_idx = knots.len().saturating_sub(degree + 1);
                        if t_max_idx > degree {
                            let t_max = knots[t_max_idx];
                            let p_end = evaluate_bspline_curve(t_max, degree, &cps, &knots);
                            // Avoid duplicating the last sampled point.
                            let near_dup = pts
                                .last()
                                .map(|p| (p - p_end).norm_squared() < 1e-18)
                                .unwrap_or(false);
                            if !near_dup {
                                pts.push(p_end);
                            }
                        }
                    }
                }
            }
        }
        return pts;
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
        return vec![start, start + dir * mag];
    }
    if kind == "IFCCIRCLE" {
        let radius = curve.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
        if radius <= 0.0 {
            return Vec::new();
        }
        let placement = match curve.get(0).and_then(|a| decoder.resolve_ref(a).ok().flatten()) {
            Some(p) => p,
            None => return Vec::new(),
        };
        let (center, axis_z, axis_x) = read_axis2_placement_3d(&placement, decoder);
        let axis_y = axis_z.cross(&axis_x);
        let n = scale_segments(24, 8, 96, quality);
        return (0..=n)
            .map(|i| {
                let a = TAU * (i as f64) / (n as f64);
                center + axis_x * (radius * a.cos()) + axis_y * (radius * a.sin())
            })
            .collect();
    }
    if kind == "IFCTRIMMEDCURVE" {
        // 0=BasisCurve, 1=Trim1, 2=Trim2, 3=Sense, 4=MasterRepresentation.
        let basis = match curve.get(0).and_then(|a| decoder.resolve_ref(a).ok().flatten()) {
            Some(b) => b,
            None => return Vec::new(),
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
                return pts;
            }
        }
        if basis_kind == "IFCBSPLINECURVEWITHKNOTS" {
            if let (Some(p_start), Some(p_end)) = (p1, p2) {
                let mut pts = sample_bspline_edge_curve(&basis, &p_start, sense, decoder, quality);
                pts.push(p_end);
                return pts;
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
                return if sense {
                    vec![p_start, p_end]
                } else {
                    vec![p_end, p_start]
                };
            }
        }
        return sample_curve_polyline(&basis, decoder, quality);
    }
    Vec::new()
}
