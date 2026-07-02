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
        let pnt_attr = line
            .get(0)
            .ok_or_else(|| Error::geometry("Line missing Pnt".to_string()))?;
        let pnt = decoder
            .resolve_ref(pnt_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Line Pnt".to_string()))?;
        let coords = pnt
            .get(0)
            .and_then(|v| v.as_list())
            .ok_or_else(|| Error::geometry("Line Pnt missing coordinates".to_string()))?;
        let origin = Point3::new(
            coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
            coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
            coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0),
        );

        // Dir is an IfcVector: 0=Orientation (IfcDirection), 1=Magnitude.
        let dir_attr = line
            .get(1)
            .ok_or_else(|| Error::geometry("Line missing Dir".to_string()))?;
        let vector = decoder
            .resolve_ref(dir_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Line Dir".to_string()))?;
        let magnitude = vector.get(1).and_then(|v| v.as_float()).unwrap_or(1.0);
        let orientation = vector
            .get(0)
            .and_then(|a| decoder.resolve_ref(a).ok().flatten())
            .and_then(|d| {
                let coords = d.get(0).and_then(|v| v.as_list())?;
                Some(Vector3::new(
                    coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                    coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                    coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0),
                ))
            })
            .and_then(|v| v.try_normalize(1e-12))
            .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0));
        Ok((origin, orientation * magnitude))
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

    /// Resolve one `IfcTrimmingSelect` bound on a trimmed `IfcLine` to a 3D point.
    /// A parameter bound `t` maps to `origin + t·v`; a cartesian bound is used as
    /// authored. Mirrors [`Self::extract_trim_select`] but keeps the full 3D
    /// coordinate (the 2D variant drops z, which a swept directrix must retain).
    fn line_trim_point_3d(
        &self,
        attr: Option<&AttributeValue>,
        origin: &Point3<f64>,
        v: &Vector3<f64>,
        prefer_cartesian: bool,
        decoder: &mut EntityDecoder,
    ) -> Option<Point3<f64>> {
        let list = attr?.as_list()?;
        let mut param: Option<f64> = None;
        let mut point: Option<Point3<f64>> = None;
        for item in list {
            // IFCPARAMETERVALUE(value) is stored as List(["IFCPARAMETERVALUE", value]).
            if let Some(inner) = item.as_list() {
                if let Some(name) = inner.first().and_then(|v| v.as_string()) {
                    if name == "IFCPARAMETERVALUE" {
                        param = inner.get(1).and_then(|v| v.as_float());
                        continue;
                    }
                }
            }
            if item.as_entity_ref().is_some() {
                if let Ok(Some(pt)) = decoder.resolve_ref(item) {
                    if pt.ifc_type == IfcType::IfcCartesianPoint {
                        if let Some(coords) = pt.get(0).and_then(|v| v.as_list()) {
                            point = Some(Point3::new(
                                coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                                coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                                coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0),
                            ));
                        }
                    }
                }
                continue;
            }
            if let Some(f) = item.as_float() {
                param = Some(f);
            }
        }
        match (prefer_cartesian, point, param) {
            (true, Some(p), _) => Some(p),
            (_, _, Some(t)) => Some(origin + v * t),
            (_, Some(p), None) => Some(p),
            _ => None,
        }
    }

    /// Sample a trimmed `IfcLine` directrix in 3D, honoring Trim1/Trim2 (parameter
    /// or cartesian) and SenseAgreement. Returns the segment endpoints in sweep
    /// order.
    pub(super) fn process_trimmed_line_3d(
        &self,
        trimmed: &DecodedEntity,
        line: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point3<f64>>> {
        let (origin, v) = self.read_line_3d(line, decoder)?;
        let prefer_cartesian = trimmed
            .get(4)
            .and_then(|m| m.as_enum())
            .map(|m| m == "CARTESIAN")
            .unwrap_or(false);
        let p_start = self.line_trim_point_3d(trimmed.get(1), &origin, &v, prefer_cartesian, decoder);
        let p_end = self.line_trim_point_3d(trimmed.get(2), &origin, &v, prefer_cartesian, decoder);
        let sense = trimmed
            .get(3)
            .and_then(|x| match x {
                AttributeValue::Enum(s) => Some(s == "T"),
                _ => None,
            })
            .unwrap_or(true);
        let start = p_start.unwrap_or(origin);
        let end = p_end.unwrap_or(origin + v);
        Ok(if sense {
            vec![start, end]
        } else {
            vec![end, start]
        })
    }

    /// Read a conic's placement (`IfcCircle`/`IfcEllipse` Position) as a full 3D
    /// frame: `(center, x_axis, y_axis)`. Handles both `IfcAxis2Placement3D`
    /// (Location + Axis(Z) + RefDirection(X), with Y = Z × X) and the planar
    /// `IfcAxis2Placement2D` (Location + RefDirection(X) in the XY plane, Y the
    /// 90° CCW perpendicular). Used by both the full-circle sampler and the
    /// trimmed-arc sampler so a 3D-placed arc is never flattened to z=0.
    fn read_conic_placement_3d(
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

        if position.ifc_type == IfcType::IfcAxis2Placement3D {
            // IfcAxis2Placement3D: Location, Axis (Z), RefDirection (X)
            let loc_attr = position
                .get(0)
                .ok_or_else(|| Error::geometry("Axis2Placement3D missing Location".to_string()))?;
            let loc = decoder
                .resolve_ref(loc_attr)?
                .ok_or_else(|| Error::geometry("Failed to resolve location".to_string()))?;
            let coords = loc
                .get(0)
                .and_then(|v| v.as_list())
                .ok_or_else(|| Error::geometry("Location missing coordinates".to_string()))?;
            let center = Point3::new(
                coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0),
            );

            // Get Z axis (Axis attribute)
            let z_axis = if let Some(axis_attr) = position.get(1) {
                if !axis_attr.is_null() {
                    let axis = decoder.resolve_ref(axis_attr)?;
                    if let Some(axis) = axis {
                        let coords = axis.get(0).and_then(|v| v.as_list());
                        if let Some(coords) = coords {
                            Vector3::new(
                                coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                                coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                                coords.get(2).and_then(|v| v.as_float()).unwrap_or(1.0),
                            )
                            .normalize()
                        } else {
                            Vector3::new(0.0, 0.0, 1.0)
                        }
                    } else {
                        Vector3::new(0.0, 0.0, 1.0)
                    }
                } else {
                    Vector3::new(0.0, 0.0, 1.0)
                }
            } else {
                Vector3::new(0.0, 0.0, 1.0)
            };

            // Get X axis (RefDirection attribute)
            let x_axis = if let Some(ref_attr) = position.get(2) {
                if !ref_attr.is_null() {
                    let ref_dir = decoder.resolve_ref(ref_attr)?;
                    if let Some(ref_dir) = ref_dir {
                        let coords = ref_dir.get(0).and_then(|v| v.as_list());
                        if let Some(coords) = coords {
                            Vector3::new(
                                coords.first().and_then(|v| v.as_float()).unwrap_or(1.0),
                                coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                                coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0),
                            )
                            .normalize()
                        } else {
                            Vector3::new(1.0, 0.0, 0.0)
                        }
                    } else {
                        Vector3::new(1.0, 0.0, 0.0)
                    }
                } else {
                    Vector3::new(1.0, 0.0, 0.0)
                }
            } else {
                Vector3::new(1.0, 0.0, 0.0)
            };

            // Y axis = Z cross X
            let y_axis = z_axis.cross(&x_axis).normalize();

            Ok((center, x_axis, y_axis))
        } else {
            // Planar IfcAxis2Placement2D: Location + RefDirection (X) at index 1.
            // Build the frame in the XY plane (z = 0), honouring RefDirection so a
            // rotated arc keeps its orientation (matches the 2D conic sampler).
            let loc_attr = position.get(0);
            let (cx, cy) = if let Some(attr) = loc_attr {
                let loc = decoder.resolve_ref(attr)?;
                if let Some(loc) = loc {
                    let coords = loc.get(0).and_then(|v| v.as_list());
                    if let Some(coords) = coords {
                        (
                            coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                            coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                        )
                    } else {
                        (0.0, 0.0)
                    }
                } else {
                    (0.0, 0.0)
                }
            } else {
                (0.0, 0.0)
            };
            let x_axis = position
                .get(1)
                .filter(|a| !a.is_null())
                .and_then(|a| decoder.resolve_ref(a).ok().flatten())
                .and_then(|d| {
                    let coords = d.get(0).and_then(|v| v.as_list())?;
                    Some(Vector3::new(
                        coords.first().and_then(|v| v.as_float()).unwrap_or(1.0),
                        coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                        0.0,
                    ))
                })
                .and_then(|v| v.try_normalize(1e-12))
                .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0));
            // 90° CCW perpendicular in the XY plane.
            let y_axis = Vector3::new(-x_axis.y, x_axis.x, 0.0);
            Ok((Point3::new(cx, cy, 0.0), x_axis, y_axis))
        }
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

        let sense = trimmed
            .get(3)
            .and_then(|v| match v {
                AttributeValue::Enum(s) => Some(s == "T"),
                _ => None,
            })
            .unwrap_or(true);

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
            )
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
            )
            .unwrap_or(2.0 * PI);

        // Wrap so a sense-T arc whose end angle dropped below the start (crossed
        // the 0/360° seam) stays the short arc, not its ~360° complement.
        if sense && end_angle < start_angle {
            end_angle += 2.0 * PI;
        } else if !sense && end_angle > start_angle {
            end_angle -= 2.0 * PI;
        }

        // Segment count: same angular floor + chord-deviation budget as the 2D
        // conic sampler so density matches across the codebase.
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

        let angle_range = if sense {
            end_angle - start_angle
        } else {
            start_angle - end_angle
        };

        let mut points = Vec::with_capacity(num_segments + 1);
        for i in 0..=num_segments {
            let t = i as f64 / num_segments as f64;
            let angle = if sense {
                start_angle + t * angle_range
            } else {
                start_angle - t * angle_range.abs()
            };
            let p = center
                + x_axis * (radius * angle.cos())
                + y_axis * (radius2 * angle.sin());
            points.push(p);
        }

        Ok(points)
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
    ) -> Option<f64> {
        let list = attr?.as_list()?;
        let mut param: Option<f64> = None;
        let mut point: Option<Point3<f64>> = None;

        for item in list {
            // IFCPARAMETERVALUE(value) is stored as List(["IFCPARAMETERVALUE", value]).
            if let Some(inner_list) = item.as_list() {
                if let Some(type_name) = inner_list.first().and_then(|v| v.as_string()) {
                    if type_name == "IFCPARAMETERVALUE" {
                        param = inner_list.get(1).and_then(|v| v.as_float());
                        continue;
                    }
                }
            }
            // A reference to an IfcCartesianPoint (kept in full 3D).
            if item.as_entity_ref().is_some() {
                if let Ok(Some(pt)) = decoder.resolve_ref(item) {
                    if pt.ifc_type == IfcType::IfcCartesianPoint {
                        if let Some(coords) = pt.get(0).and_then(|v| v.as_list()) {
                            point = Some(Point3::new(
                                coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                                coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                                coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0),
                            ));
                        }
                    }
                }
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
                return Some((ly / radius2).atan2(lx / radius));
            }
        }
        param.map(|v| v * angle_scale)
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
            // IfcCartesianPoint: Coordinates
            let coords_attr = point
                .get(0)
                .ok_or_else(|| Error::geometry("CartesianPoint missing Coordinates".to_string()))?;

            let coords = coords_attr
                .as_list()
                .ok_or_else(|| Error::geometry("Coordinates is not a list".to_string()))?;

            let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
            let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
            let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);

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

        // IfcCartesianPointList3D has 3-tuples; IfcCartesianPointList2D has
        // 2-tuples. Read whatever is there and default missing components to 0.
        let all_points: Vec<Point3<f64>> = coord_list
            .iter()
            .filter_map(|coord| {
                coord.as_list().map(|coords| {
                    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                    let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                    Point3::new(x, y, z)
                })
            })
            .collect();

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
            // Each segment is IFCLINEINDEX((i1,i2,...)) or IFCARCINDEX((i1,i2,i3)).
            // Typed values arrive as List([String("IFCLINEINDEX"), List([indices...])]).
            let (is_arc, indices) = if let Some(segment_list) = segment.as_list() {
                if segment_list.len() >= 2 {
                    let type_name = segment_list
                        .first()
                        .and_then(|v| v.as_string())
                        .unwrap_or("");
                    let is_arc_type = type_name.to_uppercase().contains("ARC");
                    if let Some(AttributeValue::List(indices_list)) = segment_list.get(1) {
                        (is_arc_type, Some(indices_list.as_slice()))
                    } else {
                        (false, Some(segment_list))
                    }
                } else {
                    (false, Some(segment_list))
                }
            } else {
                (false, None)
            };

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
                    let mid_offset = mid - Point3::new(
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
