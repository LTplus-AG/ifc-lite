// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{ProfileProcessor, TrimSelect};
use crate::{Error, Point2, Result};
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use std::f64::consts::PI;

impl ProfileProcessor {
    /// Extract a single bound of an `IfcTrimmingSelect` list.
    ///
    /// Per the schema each `Trim1`/`Trim2` is a SET of 1..2 of
    /// `IfcParameterValue` and/or `IfcCartesianPoint`. We gather both flavours
    /// when present and let `prefer_cartesian` (derived from the curve's
    /// MasterRepresentation) pick the winner, falling back to whichever one is
    /// actually authored. Cartesian bounds are returned as raw points; the
    /// caller converts them to an angle once it knows the conic's centre,
    /// rotation, and radii — a point bound cannot be turned into a parameter
    /// without that placement.
    pub(super) fn extract_trim_select(
        &self,
        attr: &ifc_lite_core::AttributeValue,
        prefer_cartesian: bool,
        decoder: &mut EntityDecoder,
    ) -> Option<TrimSelect> {
        let list = attr.as_list()?;
        let mut param: Option<f64> = None;
        let mut point: Option<Point2<f64>> = None;

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
            // A reference to an IfcCartesianPoint.
            if item.as_entity_ref().is_some() {
                if let Ok(Some(pt)) = decoder.resolve_ref(item) {
                    if pt.ifc_type == IfcType::IfcCartesianPoint {
                        if let Some(coords) = pt.get(0).and_then(|v| v.as_list()) {
                            let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                            let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                            point = Some(Point2::new(x, y));
                        }
                    }
                }
                continue;
            }
            // Bare numeric fallback: a parameter authored without the
            // IFCPARAMETERVALUE wrapper.
            if let Some(f) = item.as_float() {
                param = Some(f);
            }
        }

        match (prefer_cartesian, point, param) {
            (true, Some(p), _) => Some(TrimSelect::Cartesian(p)),
            (_, _, Some(f)) => Some(TrimSelect::Parameter(f)),
            (_, Some(p), None) => Some(TrimSelect::Cartesian(p)),
            _ => None,
        }
    }

    /// Process trimmed conic (circle or ellipse arc)
    pub(super) fn process_trimmed_conic(
        &self,
        basis: &DecodedEntity,
        trim1: Option<TrimSelect>,
        trim2: Option<TrimSelect>,
        sense: bool,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        let radius = basis.get_float(1).unwrap_or(1.0);
        let radius2 = if basis.ifc_type == IfcType::IfcEllipse {
            basis.get_float(2).unwrap_or(radius)
        } else {
            radius
        };

        let (center, rotation) = self.get_placement_2d(basis, decoder)?;

        // Convert each trim bound to an angle in the conic's local frame.
        // IfcParameterValue bounds are angles in the project's PLANEANGLEUNIT
        // (defaulting to `.to_radians()` collapsed 240° arcs to ~4° on
        // RADIAN-declared files — issue #820, Renga export). IfcCartesianPoint
        // bounds (MasterRepresentation `.CARTESIAN.`, issue #953) are inverted
        // through the placement: un-rotate about the centre, then read the
        // parametric angle off the radii. Without this the cartesian-trimmed
        // semicircle wall profiles in Roof-01_BCAD lost their arc entirely.
        let angle_scale = decoder.plane_angle_to_radians();
        let to_angle = |trim: &TrimSelect| -> f64 {
            match trim {
                TrimSelect::Parameter(v) => v * angle_scale,
                TrimSelect::Cartesian(p) => {
                    let dx = p.x - center.x;
                    let dy = p.y - center.y;
                    let lx = dx * rotation.cos() + dy * rotation.sin();
                    let ly = -dx * rotation.sin() + dy * rotation.cos();
                    // Normalise by the radii so ellipse bounds map to the
                    // parametric angle (for a circle radius == radius2, so this
                    // is plain atan2(ly, lx)).
                    (ly / radius2).atan2(lx / radius)
                }
            }
        };
        let start_angle = trim1.as_ref().map(&to_angle).unwrap_or(0.0);
        let mut end_angle = trim2
            .as_ref()
            .map(&to_angle)
            .unwrap_or(2.0 * std::f64::consts::PI);

        // Handle angle wrapping for arcs that cross the 0°/360° boundary.
        // Example: start=359.98°, end=0° with sense=T should be a tiny arc (~0.02°),
        // not a near-full circle (~359.98°).
        if sense && end_angle < start_angle {
            end_angle += 2.0 * std::f64::consts::PI;
        } else if !sense && end_angle > start_angle {
            end_angle -= 2.0 * std::f64::consts::PI;
        }

        // Adaptive segment count.
        //
        // Angular floor: ~8 segments per 90° (quarter circle), minimum 2 —
        // preserves the previous density for small arcs so nothing regresses.
        //
        // Chord-deviation budget: the angular floor is radius-INDEPENDENT, so a
        // large-radius arc collapses to a coarse polyline (a 12.5 m-radius, 17°
        // arc got only 2 segments → 35 mm chord deviation on a 500 mm wall,
        // ISSUE_129). Cap the sagitta to an absolute ~0.5 mm by adding segments
        // for large physical radii. The budget is expressed in metres and
        // converted through the file's length-unit scale, so it is the same
        // 0.5 mm whether the model is authored in mm or m. The sagitta/radius
        // ratio is `1 - cos(step/2)`; solve for the max step that keeps it
        // within budget. Bounded so a mis-resolved unit can't explode the count.
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
        // Profile arc: historical chord-adaptive density at Medium+ (never finer
        // — denser caps only add earcut bridge slivers), coarser below Medium so
        // large channel/angle fillets don't dominate on preview levels.
        let num_segments = self
            .quality()
            .profile_arc_segments(by_angle.max(by_chord), 2)
            .min(128);
        let mut points = Vec::with_capacity(num_segments + 1);

        let angle_range = if sense {
            end_angle - start_angle
        } else {
            start_angle - end_angle
        };

        for i in 0..=num_segments {
            let t = i as f64 / num_segments as f64;
            let angle = if sense {
                start_angle + t * angle_range
            } else {
                start_angle - t * angle_range.abs()
            };

            let x = radius * angle.cos();
            let y = radius2 * angle.sin();

            let rx = x * rotation.cos() - y * rotation.sin() + center.x;
            let ry = x * rotation.sin() + y * rotation.cos() + center.y;

            points.push(Point2::new(rx, ry));
        }

        Ok(points)
    }

    /// Get 2D placement from entity
    fn get_placement_2d(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(Point2<f64>, f64)> {
        let placement_attr = match entity.get(0) {
            Some(attr) if !attr.is_null() => attr,
            _ => return Ok((Point2::new(0.0, 0.0), 0.0)),
        };

        let placement = match decoder.resolve_ref(placement_attr)? {
            Some(p) => p,
            None => return Ok((Point2::new(0.0, 0.0), 0.0)),
        };

        let location_attr = placement.get(0);
        let center = if let Some(loc_attr) = location_attr {
            if let Some(loc) = decoder.resolve_ref(loc_attr)? {
                let coords = loc.get(0).and_then(|v| v.as_list());
                if let Some(coords) = coords {
                    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                    Point2::new(x, y)
                } else {
                    Point2::new(0.0, 0.0)
                }
            } else {
                Point2::new(0.0, 0.0)
            }
        } else {
            Point2::new(0.0, 0.0)
        };

        // RefDirection lives at attribute index 1 on IfcAxis2Placement2D, but at
        // index 2 on IfcAxis2Placement3D (index 1 is the Z-Axis there). Reading
        // attribute 1 unconditionally produced a rotation of 0° for any conic
        // anchored to a 3D placement — fine for Z-up profiles but visibly wrong
        // when the X axis is rotated in-plane. Trimmed circles authored with
        // `IfcAxis2Placement3D` (e.g. Revit reinforcement bars in Rebar2.ifc,
        // issue #631) all came out with their arc centres rotated by their
        // RefDirection angle, distorting the directrix.
        let ref_dir_attr_index = if placement.ifc_type == IfcType::IfcAxis2Placement3D {
            2
        } else {
            1
        };
        let rotation = if let Some(dir_attr) = placement.get(ref_dir_attr_index) {
            if let Some(dir) = decoder.resolve_ref(dir_attr)? {
                let ratios = dir.get(0).and_then(|v| v.as_list());
                if let Some(ratios) = ratios {
                    let x = ratios.first().and_then(|v| v.as_float()).unwrap_or(1.0);
                    let y = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                    y.atan2(x)
                } else {
                    0.0
                }
            } else {
                0.0
            }
        } else {
            0.0
        };

        Ok((center, rotation))
    }

    /// Process circle curve (full circle)
    pub(super) fn process_circle_curve(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        let radius = curve.get_float(1).unwrap_or(1.0);
        let (center, rotation) = self.get_placement_2d(curve, decoder)?;

        let segments = self.quality().circle_profile_segments(36);
        let mut points = Vec::with_capacity(segments);

        for i in 0..segments {
            let angle = (i as f64) * 2.0 * PI / (segments as f64);
            let x = radius * angle.cos();
            let y = radius * angle.sin();

            let rx = x * rotation.cos() - y * rotation.sin() + center.x;
            let ry = x * rotation.sin() + y * rotation.cos() + center.y;

            points.push(Point2::new(rx, ry));
        }

        Ok(points)
    }

    /// Process ellipse curve (full ellipse)
    pub(super) fn process_ellipse_curve(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        let semi_axis1 = curve.get_float(1).unwrap_or(1.0);
        let semi_axis2 = curve.get_float(2).unwrap_or(1.0);
        let (center, rotation) = self.get_placement_2d(curve, decoder)?;

        let segments = self.quality().circle_profile_segments(36);
        let mut points = Vec::with_capacity(segments);

        for i in 0..segments {
            let angle = (i as f64) * 2.0 * PI / (segments as f64);
            let x = semi_axis1 * angle.cos();
            let y = semi_axis2 * angle.sin();

            let rx = x * rotation.cos() - y * rotation.sin() + center.x;
            let ry = x * rotation.sin() + y * rotation.cos() + center.y;

            points.push(Point2::new(rx, ry));
        }

        Ok(points)
    }

    /// Process polyline into 2D points
    /// IfcPolyline: Points (list of IfcCartesianPoint)
    #[inline]
    pub(super) fn process_polyline(
        &self,
        polyline: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        // Get points list (attribute 0)
        let points_attr = polyline
            .get(0)
            .ok_or_else(|| Error::geometry("Polyline missing Points".to_string()))?;

        let point_entities = decoder.resolve_ref_list(points_attr)?;

        let mut points = Vec::with_capacity(point_entities.len());
        for point_entity in point_entities {
            if point_entity.ifc_type != IfcType::IfcCartesianPoint {
                continue;
            }

            // Get coordinates (attribute 0)
            let coords_attr = point_entity
                .get(0)
                .ok_or_else(|| Error::geometry("CartesianPoint missing coordinates".to_string()))?;

            let coords = coords_attr
                .as_list()
                .ok_or_else(|| Error::geometry("Expected coordinate list".to_string()))?;

            let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
            let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);

            points.push(Point2::new(x, y));
        }

        Ok(points)
    }

    /// Process indexed polycurve into 2D points
    /// IfcIndexedPolyCurve: Points (IfcCartesianPointList2D), Segments (optional), SelfIntersect
    pub(super) fn process_indexed_polycurve(
        &self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        // Get points list (attribute 0) - references IfcCartesianPointList2D
        let points_attr = curve
            .get(0)
            .ok_or_else(|| Error::geometry("IndexedPolyCurve missing Points".to_string()))?;

        let points_list = decoder
            .resolve_ref(points_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Points list".to_string()))?;

        // IfcCartesianPointList2D: CoordList (list of 2D coordinates)
        let coord_list_attr = points_list
            .get(0)
            .ok_or_else(|| Error::geometry("CartesianPointList2D missing CoordList".to_string()))?;

        let coord_list = coord_list_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected coordinate list".to_string()))?;

        // Parse all 2D points from the coordinate list
        let all_points: Vec<Point2<f64>> = coord_list
            .iter()
            .filter_map(|coord| {
                coord.as_list().and_then(|coords| {
                    let x = coords.first()?.as_float()?;
                    let y = coords.get(1)?.as_float()?;
                    Some(Point2::new(x, y))
                })
            })
            .collect();

        // Get segments (attribute 1) - optional, if not present use all points in order
        let segments_attr = curve.get(1);

        if segments_attr.is_none() || segments_attr.map(|a| a.is_null()).unwrap_or(true) {
            // No segments specified - use all points in order
            return Ok(all_points);
        }

        // Process segments (IfcLineIndex or IfcArcIndex)
        let segments = segments_attr
            .unwrap()
            .as_list()
            .ok_or_else(|| Error::geometry("Expected segments list".to_string()))?;

        let mut result_points = Vec::new();

        for segment in segments {
            // Each segment is either IFCLINEINDEX((i1,i2,...)) or IFCARCINDEX((i1,i2,i3))
            // Typed values are stored as List([String("IFCLINEINDEX"), List([indices...])])
            // So we need to extract the inner list AND check the type name
            let (is_arc, indices) = if let Some(segment_list) = segment.as_list() {
                // Check if this is a typed value: List([String(type_name), List([indices...])])
                // Typed values like IFCLINEINDEX((1,2)) are stored as:
                // List([String("IFCLINEINDEX"), List([Integer(1), Integer(2)])])
                if segment_list.len() >= 2 {
                    // First element is type name (String), second is the actual indices list
                    let type_name = segment_list
                        .first()
                        .and_then(|v| v.as_string())
                        .unwrap_or("");
                    let is_arc_type = type_name.to_uppercase().contains("ARC");
                    if let Some(AttributeValue::List(indices_list)) = segment_list.get(1) {
                        (is_arc_type, Some(indices_list.as_slice()))
                    } else {
                        // Fallback: maybe it's a direct list of indices (not typed)
                        (false, Some(segment_list))
                    }
                } else {
                    // Single element or empty - treat as direct list (line)
                    (false, Some(segment_list))
                }
            } else {
                (false, None)
            };

            if let Some(indices) = indices {
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
                    // Arc segment - 3 points define an arc (ONLY if type is IFCARCINDEX)
                    let p1 = all_points.get(idx_values[0]).copied();
                    let p2 = all_points.get(idx_values[1]).copied(); // Mid-point
                    let p3 = all_points.get(idx_values[2]).copied();

                    if let (Some(start), Some(mid), Some(end)) = (p1, p2, p3) {
                        // Approximate arc with adaptive segment count based on arc size
                        // Calculate approximate arc angle from chord length vs radius
                        let chord_len =
                            ((end.x - start.x).powi(2) + (end.y - start.y).powi(2)).sqrt();
                        let mid_chord = ((mid.x - (start.x + end.x) / 2.0).powi(2)
                            + (mid.y - (start.y + end.y) / 2.0).powi(2))
                        .sqrt();
                        // Estimate arc angle: larger mid deviation = larger arc
                        // Sweep angle from chord c and sagitta s: a circular arc
                        // has s/c = (1/2)tan(phi/4), so phi = 4*atan(2s/c). (The
                        // old 2*acos(s/c) was inverted: flat arcs got the most
                        // segments, tight arcs the fewest.)
                        let arc_estimate = if chord_len > 1e-10 {
                            4.0 * (2.0 * mid_chord / chord_len).atan()
                        } else {
                            0.5
                        };
                        // 2D profile arc → extruded cap. Medium+ keeps historical
                        // density; below Medium it coarsens.
                        let arc_base =
                            (arc_estimate / std::f64::consts::FRAC_PI_2 * 8.0).ceil() as usize;
                        let num_segments =
                            self.quality().profile_arc_segments(arc_base, 4).min(16);
                        let arc_points = self.approximate_arc_3pt(start, mid, end, num_segments);
                        for pt in arc_points {
                            if result_points.last() != Some(&pt) {
                                result_points.push(pt);
                            }
                        }
                    }
                } else {
                    // Line segment - add all points (includes IFCLINEINDEX with any number of points)
                    for &idx in &idx_values {
                        if let Some(&pt) = all_points.get(idx) {
                            if result_points.last() != Some(&pt) {
                                result_points.push(pt);
                            }
                        }
                    }
                }
            }
            // else: segment is not a list, skip it
        }

        Ok(result_points)
    }

    /// Approximate a 3-point arc with line segments
    fn approximate_arc_3pt(
        &self,
        p1: Point2<f64>,
        p2: Point2<f64>,
        p3: Point2<f64>,
        num_segments: usize,
    ) -> Vec<Point2<f64>> {
        // Find circle center from 3 points
        let ax = p1.x;
        let ay = p1.y;
        let bx = p2.x;
        let by = p2.y;
        let cx = p3.x;
        let cy = p3.y;

        let d = 2.0 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));

        // Check for collinearity using a RELATIVE tolerance based on the arc span
        // The determinant d scales with the square of the point distances
        let arc_span = ((p3.x - p1.x).powi(2) + (p3.y - p1.y).powi(2)).sqrt();
        let collinear_tolerance = 1e-6 * arc_span.powi(2).max(1e-10);
        if d.abs() < collinear_tolerance {
            // Points are collinear - return as line
            return vec![p1, p2, p3];
        }

        // Calculate center
        let ux_num = (ax * ax + ay * ay) * (by - cy)
            + (bx * bx + by * by) * (cy - ay)
            + (cx * cx + cy * cy) * (ay - by);
        let uy_num = (ax * ax + ay * ay) * (cx - bx)
            + (bx * bx + by * by) * (ax - cx)
            + (cx * cx + cy * cy) * (bx - ax);
        let ux = ux_num / d;
        let uy = uy_num / d;
        let center = Point2::new(ux, uy);
        let radius = ((p1.x - center.x).powi(2) + (p1.y - center.y).powi(2)).sqrt();
        // If radius is more than 100x the arc span, the points are essentially collinear
        if radius > arc_span * 100.0 {
            return vec![p1, p2, p3];
        }

        // Calculate angles
        let angle1 = (p1.y - center.y).atan2(p1.x - center.x);
        let angle3 = (p3.y - center.y).atan2(p3.x - center.x);
        let angle2 = (p2.y - center.y).atan2(p2.x - center.x);

        // Normalize angle difference to [-PI, PI]
        fn normalize_angle(a: f64) -> f64 {
            let mut a = a % (2.0 * PI);
            if a > PI {
                a -= 2.0 * PI;
            } else if a < -PI {
                a += 2.0 * PI;
            }
            a
        }

        // Determine if we should go clockwise or counterclockwise from angle1 to angle3
        // The correct direction is the one that passes through angle2
        let diff_direct = normalize_angle(angle3 - angle1);
        let diff_to_mid = normalize_angle(angle2 - angle1);
        let go_direct = if diff_direct > 0.0 {
            // Direct path is counterclockwise (positive angles)
            diff_to_mid > 0.0 && diff_to_mid < diff_direct
        } else {
            // Direct path is clockwise (negative angles)
            diff_to_mid < 0.0 && diff_to_mid > diff_direct
        };

        let start_angle = angle1;
        let end_angle = if go_direct {
            angle1 + diff_direct
        } else {
            // Go the other way around
            if diff_direct > 0.0 {
                angle1 + diff_direct - 2.0 * PI
            } else {
                angle1 + diff_direct + 2.0 * PI
            }
        };

        // Generate arc points
        let mut points = Vec::with_capacity(num_segments + 1);
        for i in 0..=num_segments {
            let t = i as f64 / num_segments as f64;
            let angle = start_angle + t * (end_angle - start_angle);
            points.push(Point2::new(
                center.x + radius * angle.cos(),
                center.y + radius * angle.sin(),
            ));
        }

        points
    }
}
