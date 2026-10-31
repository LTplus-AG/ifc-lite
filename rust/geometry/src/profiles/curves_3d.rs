// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::outline::{approximate_arc_3pt_3d, same_point_3d, trim_polyline};
use super::ProfileProcessor;
use crate::tessellation::scale_segments;
use crate::{Error, Point3, Result, Vector3};
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use std::f64::consts::PI;

impl ProfileProcessor {
    /// Read an `IfcLine`'s origin point and its geometric direction vector.
    ///
    /// `IfcLine` = (Pnt: IfcCartesianPoint, Dir: IfcVector). The IfcVector carries
    /// an `Orientation` (IfcDirection) and a `Magnitude`; the line's geometric
    /// direction is `Magnitude · normalize(Orientation)`, so the curve point at
    /// parameter `u` is `Pnt + u · V`.
    fn read_line_3d(
        &self,
        line: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(Point3<f64>, Vector3<f64>)> {
        let (origin, direction) = crate::curve_source::mesh_line_basis(line, decoder)?;
        Ok((Point3::from(origin), Vector3::from(direction)))
    }

    /// Sample a bare (untrimmed) `IfcLine` as the two-point segment spanning the
    /// parameter range `[t_start, t_end]`. Public so the swept-disk processor can
    /// apply a solid's `StartParam`/`EndParam` to a raw line directrix.
    pub fn get_line_points_3d(
        &self,
        line: &DecodedEntity,
        decoder: &mut EntityDecoder,
        t_start: f64,
        t_end: f64,
    ) -> Result<Vec<Point3<f64>>> {
        let (origin, v) = self.read_line_3d(line, decoder)?;
        Ok(vec![origin + v * t_start, origin + v * t_end])
    }

    /// Sample the shared IFC trimmed-line interpretation in sweep order.
    pub(super) fn process_trimmed_line_3d(
        &self,
        trimmed: &DecodedEntity,
        line: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point3<f64>>> {
        use crate::trimmed_curve::{decode_trimmed_primitive, TrimRecovery, TrimmedPrimitive};
        let Some(TrimmedPrimitive::Line { start, end }) =
            decode_trimmed_primitive(trimmed, line, decoder, TrimRecovery::BasisDefaults)?
        else {
            return Err(Error::geometry("Expected trimmed line".to_string()));
        };
        Ok(vec![Point3::from(start), Point3::from(end)])
    }

    /// Read a conic's placement (`IfcCircle`/`IfcEllipse` Position) as a full 3D
    /// frame: `(center, x_axis, y_axis)`, from either `IfcAxis2Placement3D` or
    /// the planar `IfcAxis2Placement2D`. Used by both the full-circle sampler
    /// and the trimmed-arc sampler so a 3D-placed arc is never flattened to z=0.
    ///
    /// Both kinds go through the canonical reader, [`crate::placement::Axis2Placement`],
    /// (#7687, PROC-13), as the trimmed-circle path (`circle_basis`) already
    /// did. This reader's own copy normalised a zero Axis to NaN and used a
    /// RefDirection not perpendicular to Axis as written, tilting the circle
    /// out of its plane, so a full circle and a trimmed circle on the same
    /// placement sampled different curves.
    pub(super) fn read_conic_placement_3d(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(Point3<f64>, Vector3<f64>, Vector3<f64>)> {
        let position_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("Conic missing Position".to_string()))?;
        let position = decoder
            .resolve_ref(position_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve conic position".to_string()))?;
        let frame = crate::placement::Axis2Placement::read(&position, decoder)?.matrix();
        let column = |c: usize| Vector3::new(frame[(0, c)], frame[(1, c)], frame[(2, c)]);
        let center = Point3::new(frame[(0, 3)], frame[(1, 3)], frame[(2, 3)]);
        Ok((center, column(0), column(1)))
    }

    /// Process circle curve in 3D space (for swept disk solid, etc.)
    pub(super) fn process_circle_3d(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point3<f64>>> {
        // IfcCircle: Position (IfcAxis2Placement2D or 3D), Radius
        let radius = curve
            .get_float(1)
            .ok_or_else(|| Error::geometry("Circle missing Radius".to_string()))?;

        let (center, x_axis, y_axis) = self.read_conic_placement_3d(curve, decoder)?;

        // Generate circle points in 3D (24 at Medium, scaled by quality)
        let segments = scale_segments(24, 8, 96, self.quality());
        let mut points = Vec::with_capacity(segments + 1);

        for i in 0..=segments {
            let angle = 2.0 * std::f64::consts::PI * i as f64 / segments as f64;
            let p = center + x_axis * (radius * angle.cos()) + y_axis * (radius * angle.sin());
            points.push(p);
        }

        Ok(points)
    }

    /// Sample an `IfcTrimmedCurve` whose basis is an `IfcCircle`/`IfcEllipse` in
    /// FULL 3D, honouring the conic's 3D placement.
    ///
    /// The old path lifted the 2D `process_trimmed_conic` result with `z = 0`,
    /// which silently dropped any out-of-plane component of the arc. Rebar bend
    /// arcs (Tekla `IfcSweptDiskSolid` directrices) live in the XZ plane, so the
    /// flattened arc landed at the wrong place and twisted the swept tube — the
    /// L/U-bar corruption in issue #1348. Sampling against the placement's real
    /// X/Y axes keeps the arc in its true plane.
    pub(super) fn process_trimmed_conic_3d(
        &self,
        trimmed: &DecodedEntity,
        basis: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point3<f64>>> {
        if basis.ifc_type == IfcType::IfcCircle {
            use crate::trimmed_curve::{decode_trimmed_primitive, TrimRecovery, TrimmedPrimitive};
            // The source description rejects malformed circle bases; keep the
            // mesh sampler's prior recovery for those files (notably #5566).
            let decoded = match decode_trimmed_primitive(
                trimmed,
                basis,
                decoder,
                TrimRecovery::BasisDefaultsStrictPoints,
            ) {
                Ok(decoded) => decoded,
                Err(_) => return self.process_trimmed_ellipse_3d(trimmed, basis, decoder),
            };
            let Some(TrimmedPrimitive::Circle {
                center,
                normal: _,
                x_axis,
                y_axis,
                radius,
                start_angle,
                sweep_angle,
            }) = decoded
            else {
                return Err(Error::geometry("Expected trimmed circle".to_string()));
            };
            return Ok(self.sample_conic_arc_3d(
                (
                    Point3::from(center),
                    Vector3::from(x_axis),
                    Vector3::from(y_axis),
                ),
                (radius, radius),
                start_angle,
                start_angle + sweep_angle,
                decoder,
            ));
        }
        self.process_trimmed_ellipse_3d(trimmed, basis, decoder)
    }

    /// Existing ellipse interpretation remains separate: analytic source segments
    /// currently support circles only.
    fn process_trimmed_ellipse_3d(
        &self,
        trimmed: &DecodedEntity,
        basis: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point3<f64>>> {
        let radius = basis.get_float(1).unwrap_or(1.0);
        let radius2 = if basis.ifc_type == IfcType::IfcEllipse {
            basis.get_float(2).unwrap_or(radius)
        } else {
            radius
        };

        let (center, x_axis, y_axis) = self.read_conic_placement_3d(basis, decoder)?;

        // MasterRepresentation (attr 4): `.CARTESIAN.` resolves bounds from the
        // trim points; otherwise parameter angles win (matching the 2D sampler).
        let prefer_cartesian = trimmed
            .get(4)
            .and_then(|v| v.as_enum())
            .map(|m| m == "CARTESIAN")
            .unwrap_or(false);

        let sense = trimmed.get_bool(3).unwrap_or(true);

        let angle_scale = decoder.plane_angle_to_radians();
        let start_angle = self
            .trim_to_angle_3d(
                trimmed.get(1),
                prefer_cartesian,
                &center,
                &x_axis,
                &y_axis,
                radius,
                radius2,
                angle_scale,
                decoder,
            )?
            .unwrap_or(0.0);
        let mut end_angle = self
            .trim_to_angle_3d(
                trimmed.get(2),
                prefer_cartesian,
                &center,
                &x_axis,
                &y_axis,
                radius,
                radius2,
                angle_scale,
                decoder,
            )?
            .unwrap_or(2.0 * PI);

        // Wrap so a sense-T arc whose end angle dropped below the start (crossed
        // the 0/360° seam) stays the short arc, not its ~360° complement.
        if sense && end_angle < start_angle {
            end_angle += 2.0 * PI;
        } else if !sense && end_angle > start_angle {
            end_angle -= 2.0 * PI;
        }

        Ok(self.sample_conic_arc_3d(
            (center, x_axis, y_axis),
            (radius, radius2),
            start_angle,
            end_angle,
            decoder,
        ))
    }

    /// Resolve one bound of an `IfcTrimmingSelect` on a 3D-placed conic to an
    /// angle in the conic's local frame. `IfcParameterValue` bounds are angles in
    /// the project's PLANEANGLEUNIT (scaled by `angle_scale`); `IfcCartesianPoint`
    /// bounds are projected onto the placement's X/Y axes and read off as
    /// `atan2`. Mirrors `extract_trim_select` + the 2D `to_angle` closure, but
    /// keeps the full 3D point so out-of-plane placements resolve correctly.
    #[allow(clippy::too_many_arguments)]
    fn trim_to_angle_3d(
        &self,
        attr: Option<&AttributeValue>,
        prefer_cartesian: bool,
        center: &Point3<f64>,
        x_axis: &Vector3<f64>,
        y_axis: &Vector3<f64>,
        radius: f64,
        radius2: f64,
        angle_scale: f64,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<f64>> {
        let Some(list) = attr.and_then(|a| a.as_list()) else {
            return Ok(None);
        };
        let mut param: Option<f64> = None;
        let mut point: Option<Point3<f64>> = None;

        for item in list {
            if let Some(value) = item.typed_value("IFCPARAMETERVALUE") {
                param = value.as_float();
                continue;
            }
            // A reference to an IfcCartesianPoint (kept in full 3D).
            if let Some(id) = item.as_entity_ref() {
                point = Some(Point3::from(decoder.point3(id)?));
                continue;
            }
            // Bare numeric fallback: a parameter without the IFCPARAMETERVALUE wrapper.
            if let Some(f) = item.as_float() {
                param = Some(f);
            }
        }

        let use_point = (prefer_cartesian && point.is_some()) || param.is_none();
        if use_point {
            if let Some(p) = point {
                let d = p - center;
                let lx = d.dot(x_axis);
                let ly = d.dot(y_axis);
                return Ok(Some((ly / radius2).atan2(lx / radius)));
            }
        }
        Ok(param.map(|v| v * angle_scale))
    }

    /// Process polyline into 3D points
    pub(super) fn process_polyline_3d(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point3<f64>>> {
        // IfcPolyline: Points
        let points_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("Polyline missing Points".to_string()))?;

        let points = decoder.resolve_ref_list(points_attr)?;
        let mut result = Vec::with_capacity(points.len());

        for point in points {
            let [x, y, z] = decoder.point3_decoded(&point)?;

            result.push(Point3::new(x, y, z));
        }

        Ok(result)
    }

    /// Sample an `IfcPolyline` directrix and trim by parameter range.
    /// IFC parameterises a polyline as `[0, N-1]` where `N` is the number of points
    /// and each segment between consecutive points contributes 1.0 to the parameter.
    /// `StartParam` / `EndParam` are converted to a fraction of the polyline and
    /// `trim_polyline` does the actual cutting (linear interpolation between sampled
    /// vertices, which is exact for piecewise-linear input).
    pub fn get_polyline_points_trimmed(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        start_param: Option<f64>,
        end_param: Option<f64>,
    ) -> Result<Vec<Point3<f64>>> {
        let points = self.process_polyline_3d(curve, decoder)?;
        if points.len() < 2 {
            return Ok(points);
        }
        let max_param = (points.len() - 1) as f64;
        let s = start_param.unwrap_or(0.0).clamp(0.0, max_param);
        let e = end_param.unwrap_or(max_param).clamp(0.0, max_param);
        if e <= s {
            return Ok(Vec::new());
        }
        // Convert IFC parameter (0..N-1) to trim_polyline's local [0,1] domain
        Ok(trim_polyline(&points, s / max_param, e / max_param))
    }

    /// Process indexed polycurve in 3D space.
    ///
    /// IfcIndexedPolyCurve(Points, Segments, SelfIntersect) where Points is an
    /// IfcCartesianPointList (2D or 3D). The 2D-only sibling at
    /// `process_indexed_polycurve` is used for profile-defining curves; this
    /// version is used as a directrix for IfcSweptDiskSolid and similar 3D
    /// sweeps (issue #631 — IfcReinforcingBar stirrups).
    ///
    /// `IfcCartesianPointList2D` inputs are treated as planar at z=0 so the
    /// behavior matches the 2D path on existing fixtures.
    pub(super) fn process_indexed_polycurve_3d(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point3<f64>>> {
        let points_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("IndexedPolyCurve missing Points".to_string()))?;

        let points_list = decoder
            .resolve_ref(points_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Points list".to_string()))?;

        let coord_list = points_list
            .get(0)
            .and_then(|a| a.as_list())
            .ok_or_else(|| Error::geometry("CartesianPointList missing CoordList".to_string()))?;

        // Point-list rows are inline tuples, not CartesianPoint entities.
        // Preserve row identity: a bad row refuses the curve, never shifts indices.
        let dimension = match points_list.ifc_type.as_str() {
            "IFCCARTESIANPOINTLIST2D" => 2,
            "IFCCARTESIANPOINTLIST3D" => 3,
            _ => {
                return Err(Error::geometry(
                    "Expected CartesianPointList2D or CartesianPointList3D",
                ))
            }
        };
        let all_points: Vec<Point3<f64>> = coord_list
            .iter()
            .map(|coord| {
                let row = coord
                    .as_list()
                    .filter(|row| row.len() == dimension)
                    .ok_or_else(|| Error::geometry("Invalid CartesianPointList row dimensions"))?;
                crate::curve_source::point_values(row).map(Point3::from)
            })
            .collect::<Result<_>>()?;
        let segments_attr = curve.get(1);
        if segments_attr.is_none() || segments_attr.map(|a| a.is_null()).unwrap_or(true) {
            return Ok(all_points);
        }

        let segments = segments_attr
            .unwrap()
            .as_list()
            .ok_or_else(|| Error::geometry("Expected segments list".to_string()))?;

        let mut result: Vec<Point3<f64>> = Vec::new();
        for segment in segments {
            let (is_arc, indices) = super::curves_2d::indexed_segment(segment);

            let Some(indices) = indices else { continue };
            let idx_values: Vec<usize> = indices
                .iter()
                .filter_map(|v| v.as_float())
                // 1-indexed to 0-indexed; reject non-finite, <1, or fractional
                // values (e.g. 1.9) instead of truncating them to a wrong vertex.
                .filter_map(|f| {
                    if !f.is_finite() || f < 1.0 || f.fract() != 0.0 {
                        return None;
                    }
                    (f as usize).checked_sub(1)
                })
                .collect();

            if is_arc && idx_values.len() == 3 {
                let p1 = all_points.get(idx_values[0]).copied();
                let p2 = all_points.get(idx_values[1]).copied();
                let p3 = all_points.get(idx_values[2]).copied();
                if let (Some(start), Some(mid), Some(end)) = (p1, p2, p3) {
                    // Adaptive segment count: estimate sweep from chord vs.
                    // mid-deviation, same heuristic as the 2D path.
                    let chord = end - start;
                    let chord_len = chord.norm();
                    let mid_offset = mid
                        - Point3::new(
                            0.5 * (start.x + end.x),
                            0.5 * (start.y + end.y),
                            0.5 * (start.z + end.z),
                        );
                    let mid_dev = mid_offset.norm();
                    // Sweep angle phi = 4*atan(2s/c) (s = sagitta, c = chord);
                    // the old 2*acos(s/c) was inverted. Same fix as the 2D path.
                    let arc_estimate = if chord_len > 1e-10 {
                        4.0 * (2.0 * mid_dev / chord_len).atan()
                    } else {
                        0.5
                    };
                    let arc_base =
                        (arc_estimate / std::f64::consts::FRAC_PI_2 * 8.0).ceil() as usize;
                    let num_segments = scale_segments(arc_base, 4, 16, self.quality());
                    let arc_points = approximate_arc_3pt_3d(start, mid, end, num_segments);
                    for pt in arc_points {
                        if !same_point_3d(result.last(), &pt) {
                            result.push(pt);
                        }
                    }
                }
            } else {
                // Line segment — IfcLineIndex permits any number of indices
                for &idx in &idx_values {
                    if let Some(&pt) = all_points.get(idx) {
                        if !same_point_3d(result.last(), &pt) {
                            result.push(pt);
                        }
                    }
                }
            }
        }

        Ok(result)
    }
}
