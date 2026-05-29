// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Placement and transformation: axis placement parsing, coordinate transforms, RTC offset.

use super::GeometryRouter;
use crate::profiles::ProfileProcessor;
use crate::{Error, Mesh, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

impl GeometryRouter {
    /// Apply local placement transformation to mesh
    pub(super) fn apply_placement(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        mesh: &mut Mesh,
    ) -> Result<()> {
        let placement_attr = match element.get(5) {
            Some(attr) if !attr.is_null() => attr,
            _ => return Ok(()),
        };

        let placement = match decoder.resolve_ref(placement_attr)? {
            Some(p) => p,
            None => return Ok(()),
        };

        let mut transform = self.get_placement_transform(&placement, decoder)?;
        self.scale_transform(&mut transform);
        self.transform_mesh_world(mesh, &transform);
        Ok(())
    }

    /// Get placement transform from element without applying it
    pub(super) fn get_placement_transform_from_element(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        // Get ObjectPlacement (attribute 5)
        let placement_attr = match element.get(5) {
            Some(attr) if !attr.is_null() => attr,
            _ => return Ok(Matrix4::identity()), // No placement
        };

        let placement = match decoder.resolve_ref(placement_attr)? {
            Some(p) => p,
            None => return Ok(Matrix4::identity()),
        };

        // Recursively get combined transform from placement hierarchy
        self.get_placement_transform(&placement, decoder)
    }

    /// Recursively resolve placement hierarchy
    ///
    /// Uses a depth limit (100) to prevent stack overflow on malformed files
    /// with circular placement references or extremely deep hierarchies.
    pub(super) fn get_placement_transform(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        self.get_placement_transform_with_depth(placement, decoder, 0)
    }

    /// Internal helper with depth tracking to prevent stack overflow.
    /// Keep low for WASM — each frame uses ~2KB+ of stack with Matrix4<f64> locals.
    const MAX_PLACEMENT_DEPTH: usize = 32;

    fn get_placement_transform_with_depth(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: usize,
    ) -> Result<Matrix4<f64>> {
        // Depth limit to prevent stack overflow on circular references or deep hierarchies
        if depth > Self::MAX_PLACEMENT_DEPTH {
            return Ok(Matrix4::identity());
        }

        // IfcLinearPlacement is the IFC4x3 placement used by infrastructure
        // models to put products at a station along an alignment / gradient
        // curve. Without dedicated handling, every linearly-placed element
        // (signals, referents, signs on a railway alignment) falls back to
        // identity here and piles up at world origin — the exact symptom
        // reported in issue #859 on the `linear-placement-of-signal` fixture.
        //
        // Attribute layout (IFC4x3):
        //   0 PlacementRelTo (IfcObjectPlacement, optional) — same as IfcLocalPlacement
        //   1 RelativePlacement (IfcAxis2PlacementLinear) — required, samples the curve
        //   2 CartesianPosition (IfcAxis2Placement3D, optional) — pre-baked world fallback
        if placement.ifc_type == IfcType::IfcLinearPlacement {
            return self.resolve_linear_placement_with_depth(placement, decoder, depth);
        }

        if placement.ifc_type != IfcType::IfcLocalPlacement {
            return Ok(Matrix4::identity());
        }

        // Get parent transform first (attribute 0: PlacementRelTo)
        let parent_transform = if let Some(parent_attr) = placement.get(0) {
            if !parent_attr.is_null() {
                if let Some(parent) = decoder.resolve_ref(parent_attr)? {
                    self.get_placement_transform_with_depth(&parent, decoder, depth + 1)?
                } else {
                    Matrix4::identity()
                }
            } else {
                Matrix4::identity()
            }
        } else {
            Matrix4::identity()
        };

        // Get local transform (attribute 1: RelativePlacement)
        let local_transform = if let Some(rel_attr) = placement.get(1) {
            if !rel_attr.is_null() {
                if let Some(rel) = decoder.resolve_ref(rel_attr)? {
                    if rel.ifc_type == IfcType::IfcAxis2Placement3D {
                        self.parse_axis2_placement_3d(&rel, decoder)?
                    } else {
                        Matrix4::identity()
                    }
                } else {
                    Matrix4::identity()
                }
            } else {
                Matrix4::identity()
            }
        } else {
            Matrix4::identity()
        };

        // Compose: parent * local
        Ok(parent_transform * local_transform)
    }

    /// Resolve `IfcLinearPlacement` into a 4×4 transform by sampling the
    /// referenced basis curve at the authored `DistanceAlong`. Falls back
    /// gracefully when the curve cannot be sampled or the attribute layout
    /// is malformed; never panics.
    ///
    /// Output transform: origin = curve sample + lateral·right + vertical·up
    /// + longitudinal·tangent. Basis is (tangent, right, up) with
    /// `up = (0, 0, 1)` and `right = up × tangent`. When the tangent is
    /// (nearly) vertical the frame degenerates and falls back to identity
    /// rotation about the sampled origin.
    fn resolve_linear_placement_with_depth(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: usize,
    ) -> Result<Matrix4<f64>> {
        // PlacementRelTo (attr 0) composes the same way IfcLocalPlacement does.
        let parent_transform = if let Some(parent_attr) = placement.get(0) {
            if !parent_attr.is_null() {
                if let Some(parent) = decoder.resolve_ref(parent_attr)? {
                    self.get_placement_transform_with_depth(&parent, decoder, depth + 1)?
                } else {
                    Matrix4::identity()
                }
            } else {
                Matrix4::identity()
            }
        } else {
            Matrix4::identity()
        };

        // RelativePlacement (attr 1) → IfcAxis2PlacementLinear with the curve
        // sampling info. If we can't reach a valid sample, prefer the
        // pre-baked CartesianPosition (attr 2) over identity so the element
        // at least lands somewhere sensible.
        let local = match self.try_resolve_axis2_placement_linear(placement, decoder) {
            Some(m) => m,
            None => self.try_resolve_cartesian_fallback(placement, decoder),
        };

        Ok(parent_transform * local)
    }

    /// Decode `IfcLinearPlacement.RelativePlacement` → sample the basis
    /// curve → build the local transform. Returns `None` if any required
    /// piece is missing so the caller can fall back to `CartesianPosition`.
    fn try_resolve_axis2_placement_linear(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<Matrix4<f64>> {
        let rel_attr = placement.get(1)?;
        if rel_attr.is_null() {
            return None;
        }
        let rel = decoder.resolve_ref(rel_attr).ok().flatten()?;
        if rel.ifc_type != IfcType::IfcAxis2PlacementLinear {
            return None;
        }

        // IfcAxis2PlacementLinear: 0 Location (IfcPointByDistanceExpression),
        //                          1 Axis (IfcDirection, optional, default up),
        //                          2 RefDirection (IfcDirection, optional).
        let location_attr = rel.get(0)?;
        if location_attr.is_null() {
            return None;
        }
        let location = decoder.resolve_ref(location_attr).ok().flatten()?;
        if location.ifc_type != IfcType::IfcPointByDistanceExpression {
            return None;
        }

        // IfcPointByDistanceExpression: 0 DistanceAlong (IfcLengthMeasure),
        //                               1 OffsetLateral (optional),
        //                               2 OffsetVertical (optional),
        //                               3 OffsetLongitudinal (optional),
        //                               4 BasisCurve (IfcCurve).
        let distance_along = location.get_float(0)?;
        let offset_lateral = location.get_float(1).unwrap_or(0.0);
        let offset_vertical = location.get_float(2).unwrap_or(0.0);
        let offset_longitudinal = location.get_float(3).unwrap_or(0.0);

        let basis_attr = location.get(4)?;
        if basis_attr.is_null() {
            return None;
        }
        let basis_curve = decoder.resolve_ref(basis_attr).ok().flatten()?;

        // Sample the basis curve into a polyline. `ProfileProcessor::get_curve_points`
        // already handles IfcCompositeCurve, IfcPolyline, IfcGradientCurve via its
        // composite-curve walk, IfcTrimmedCurve, IfcIndexedPolyCurve, etc. — every
        // curve type the alignment authors in #859's fixture eventually reduce to.
        let processor = ProfileProcessor::new(IfcSchema::new());
        let samples = processor
            .get_curve_points(&basis_curve, decoder)
            .ok()
            .filter(|pts| pts.len() >= 2)?;

        let (origin, tangent) = sample_polyline_at_distance(&samples, distance_along)?;

        // Build the curve-aligned frame with world-up. Railway alignments
        // are near-horizontal so this is well-conditioned; in the
        // pathological vertical-tangent case we keep an identity rotation
        // at the sampled origin rather than emit NaN axes.
        let world_up = Vector3::new(0.0, 0.0, 1.0);
        let tangent_horiz_norm =
            (tangent - world_up * tangent.dot(&world_up)).norm();
        let (x_axis, y_axis, z_axis) = if tangent_horiz_norm > 1e-9 {
            let x = tangent.normalize();
            let y = world_up.cross(&x).normalize();
            let z = x.cross(&y).normalize();
            (x, y, z)
        } else {
            (
                Vector3::new(1.0, 0.0, 0.0),
                Vector3::new(0.0, 1.0, 0.0),
                Vector3::new(0.0, 0.0, 1.0),
            )
        };

        let position = origin.coords
            + x_axis * offset_longitudinal
            + y_axis * offset_lateral
            + z_axis * offset_vertical;

        let mut m = Matrix4::<f64>::identity();
        m.fixed_view_mut::<3, 1>(0, 0).copy_from(&x_axis);
        m.fixed_view_mut::<3, 1>(0, 1).copy_from(&y_axis);
        m.fixed_view_mut::<3, 1>(0, 2).copy_from(&z_axis);
        m[(0, 3)] = position.x;
        m[(1, 3)] = position.y;
        m[(2, 3)] = position.z;
        Some(m)
    }

    /// `IfcLinearPlacement.CartesianPosition` (attr 2) is an optional
    /// pre-baked `IfcAxis2Placement3D` that authors are encouraged to
    /// supply for tools that cannot resolve the linear sampling. Use it
    /// when our sampler can't reach a result; identity otherwise.
    fn try_resolve_cartesian_fallback(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Matrix4<f64> {
        let Some(cart_attr) = placement.get(2) else {
            return Matrix4::identity();
        };
        if cart_attr.is_null() {
            return Matrix4::identity();
        }
        let Ok(Some(cart)) = decoder.resolve_ref(cart_attr) else {
            return Matrix4::identity();
        };
        if cart.ifc_type != IfcType::IfcAxis2Placement3D {
            return Matrix4::identity();
        }
        self.parse_axis2_placement_3d(&cart, decoder)
            .unwrap_or_else(|_| Matrix4::identity())
    }

    /// Parse IfcAxis2Placement3D into transformation matrix
    pub(super) fn parse_axis2_placement_3d(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        // IfcAxis2Placement3D: Location, Axis, RefDirection
        let location = self.parse_cartesian_point(placement, decoder, 0)?;

        // Default axes if not specified
        let z_axis = if let Some(axis_attr) = placement.get(1) {
            if !axis_attr.is_null() {
                if let Some(axis_entity) = decoder.resolve_ref(axis_attr)? {
                    self.parse_direction(&axis_entity)?
                } else {
                    Vector3::new(0.0, 0.0, 1.0)
                }
            } else {
                Vector3::new(0.0, 0.0, 1.0)
            }
        } else {
            Vector3::new(0.0, 0.0, 1.0)
        };

        let x_axis = if let Some(ref_dir_attr) = placement.get(2) {
            if !ref_dir_attr.is_null() {
                if let Some(ref_dir_entity) = decoder.resolve_ref(ref_dir_attr)? {
                    self.parse_direction(&ref_dir_entity)?
                } else {
                    Vector3::new(1.0, 0.0, 0.0)
                }
            } else {
                Vector3::new(1.0, 0.0, 0.0)
            }
        } else {
            Vector3::new(1.0, 0.0, 0.0)
        };

        // Y axis is cross product of Z and X
        let y_axis = z_axis.cross(&x_axis).normalize();
        let x_axis = y_axis.cross(&z_axis).normalize();
        let z_axis = z_axis.normalize();

        // Build transformation matrix
        let mut transform = Matrix4::identity();
        transform[(0, 0)] = x_axis.x;
        transform[(1, 0)] = x_axis.y;
        transform[(2, 0)] = x_axis.z;
        transform[(0, 1)] = y_axis.x;
        transform[(1, 1)] = y_axis.y;
        transform[(2, 1)] = y_axis.z;
        transform[(0, 2)] = z_axis.x;
        transform[(1, 2)] = z_axis.y;
        transform[(2, 2)] = z_axis.z;
        transform[(0, 3)] = location.x;
        transform[(1, 3)] = location.y;
        transform[(2, 3)] = location.z;

        Ok(transform)
    }

    /// Parse IfcCartesianPoint
    #[inline]
    pub(super) fn parse_cartesian_point(
        &self,
        parent: &DecodedEntity,
        decoder: &mut EntityDecoder,
        attr_index: usize,
    ) -> Result<Point3<f64>> {
        let point_attr = parent
            .get(attr_index)
            .ok_or_else(|| Error::geometry("Missing cartesian point".to_string()))?;

        let point_entity = decoder
            .resolve_ref(point_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve cartesian point".to_string()))?;

        if point_entity.ifc_type != IfcType::IfcCartesianPoint {
            return Err(Error::geometry(format!(
                "Expected IfcCartesianPoint, got {}",
                point_entity.ifc_type
            )));
        }

        // Get coordinates list (attribute 0)
        let coords_attr = point_entity
            .get(0)
            .ok_or_else(|| Error::geometry("IfcCartesianPoint missing coordinates".to_string()))?;

        let coords = coords_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected coordinate list".to_string()))?;

        let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
        let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
        let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);

        Ok(Point3::new(x, y, z))
    }

    /// Parse IfcDirection
    #[inline]
    pub(super) fn parse_direction(&self, direction_entity: &DecodedEntity) -> Result<Vector3<f64>> {
        if direction_entity.ifc_type != IfcType::IfcDirection {
            return Err(Error::geometry(format!(
                "Expected IfcDirection, got {}",
                direction_entity.ifc_type
            )));
        }

        // Get direction ratios (attribute 0)
        let ratios_attr = direction_entity
            .get(0)
            .ok_or_else(|| Error::geometry("IfcDirection missing ratios".to_string()))?;

        let ratios = ratios_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected ratio list".to_string()))?;

        let x = ratios.first().and_then(|v| v.as_float()).unwrap_or(0.0);
        let y = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
        let z = ratios.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);

        Ok(Vector3::new(x, y, z))
    }

    /// Parse IfcCartesianTransformationOperator (2D or 3D)
    /// Used for MappedItem MappingTarget transformation
    #[inline]
    pub(super) fn parse_cartesian_transformation_operator(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        // IfcCartesianTransformationOperator3D has:
        // 0: Axis1 (IfcDirection) - X axis direction (optional)
        // 1: Axis2 (IfcDirection) - Y axis direction (optional)
        // 2: LocalOrigin (IfcCartesianPoint) - translation
        // 3: Scale (IfcReal) - X axis scale (optional, defaults to 1.0)
        // 4: Axis3 (IfcDirection) - Z axis direction (optional, for 3D only)
        // IfcCartesianTransformationOperator3DNonUniform adds:
        // 5: Scale2 (IfcReal) - Y axis scale (defaults to Scale)
        // 6: Scale3 (IfcReal) - Z axis scale (defaults to Scale)
        // Without honoring attrs 5+6, every non-uniform mapped item collapses
        // to its X scale on all three axes — the drywall-panel pieces in the
        // wall-elemented-case fixture (issue #845 follow-up) ended up as
        // tiny cubes instead of tall narrow strips covering the wall area.

        // Get LocalOrigin (attribute 2)
        let origin = if let Some(origin_attr) = entity.get(2) {
            if !origin_attr.is_null() {
                if let Some(origin_entity) = decoder.resolve_ref(origin_attr)? {
                    if origin_entity.ifc_type == IfcType::IfcCartesianPoint {
                        let coords_attr = origin_entity.get(0);
                        if let Some(coords) = coords_attr.and_then(|a| a.as_list()) {
                            Point3::new(
                                coords.first().and_then(|v| v.as_float()).unwrap_or(0.0),
                                coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0),
                                coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0),
                            )
                        } else {
                            Point3::origin()
                        }
                    } else {
                        Point3::origin()
                    }
                } else {
                    Point3::origin()
                }
            } else {
                Point3::origin()
            }
        } else {
            Point3::origin()
        };

        // Get Scale (attribute 3). For IfcCartesianTransformationOperator3DNonUniform
        // this is Scale1 (X axis only); attrs 5+6 supply per-axis Y and Z scales,
        // defaulting to Scale1 when omitted.
        let scale = entity.get_float(3).unwrap_or(1.0);
        let is_non_uniform = matches!(
            entity.ifc_type,
            IfcType::IfcCartesianTransformationOperator2DnonUniform
                | IfcType::IfcCartesianTransformationOperator3DnonUniform
        );
        let scale_y = if is_non_uniform {
            entity.get_float(5).unwrap_or(scale)
        } else {
            scale
        };
        let scale_z = if is_non_uniform {
            entity.get_float(6).unwrap_or(scale)
        } else {
            scale
        };

        // Get Axis1 (X axis, attribute 0)
        let x_axis = if let Some(axis1_attr) = entity.get(0) {
            if !axis1_attr.is_null() {
                if let Some(axis1_entity) = decoder.resolve_ref(axis1_attr)? {
                    self.parse_direction(&axis1_entity)?.normalize()
                } else {
                    Vector3::new(1.0, 0.0, 0.0)
                }
            } else {
                Vector3::new(1.0, 0.0, 0.0)
            }
        } else {
            Vector3::new(1.0, 0.0, 0.0)
        };

        // Get Axis3 (Z axis, attribute 4 for 3D)
        let z_axis = if let Some(axis3_attr) = entity.get(4) {
            if !axis3_attr.is_null() {
                if let Some(axis3_entity) = decoder.resolve_ref(axis3_attr)? {
                    self.parse_direction(&axis3_entity)?.normalize()
                } else {
                    Vector3::new(0.0, 0.0, 1.0)
                }
            } else {
                Vector3::new(0.0, 0.0, 1.0)
            }
        } else {
            Vector3::new(0.0, 0.0, 1.0)
        };

        // Derive Y axis from Z and X (right-hand coordinate system)
        let y_axis = z_axis.cross(&x_axis).normalize();
        let x_axis = y_axis.cross(&z_axis).normalize();

        // Build transformation matrix. Each axis is scaled by its
        // per-axis factor (Scale / Scale2 / Scale3) so non-uniform
        // operators produce the authored anisotropic transform.
        let mut transform = Matrix4::identity();
        transform[(0, 0)] = x_axis.x * scale;
        transform[(1, 0)] = x_axis.y * scale;
        transform[(2, 0)] = x_axis.z * scale;
        transform[(0, 1)] = y_axis.x * scale_y;
        transform[(1, 1)] = y_axis.y * scale_y;
        transform[(2, 1)] = y_axis.z * scale_y;
        transform[(0, 2)] = z_axis.x * scale_z;
        transform[(1, 2)] = z_axis.y * scale_z;
        transform[(2, 2)] = z_axis.z * scale_z;
        transform[(0, 3)] = origin.x;
        transform[(1, 3)] = origin.y;
        transform[(2, 3)] = origin.z;

        Ok(transform)
    }

    /// Transform mesh by a local matrix without applying model RTC.
    ///
    /// Use this for nested representation transforms (for example IfcMappedItem
    /// mapping targets). RTC belongs to the final model/world coordinate step, not
    /// intermediate local transforms.
    #[inline]
    pub(super) fn transform_mesh_local(&self, mesh: &mut Mesh, transform: &Matrix4<f64>) {
        mesh.positions.chunks_exact_mut(3).for_each(|chunk| {
            let point = Point3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
            let t = transform.transform_point(&point);
            chunk[0] = t.x as f32;
            chunk[1] = t.y as f32;
            chunk[2] = t.z as f32;
        });

        self.transform_normals(mesh, transform);
    }

    /// Transform mesh by the final world/object placement matrix.
    ///
    /// If a model RTC offset is active, subtract it uniformly for every mesh in
    /// this final coordinate step. Meshes that already had RTC subtracted in f64
    /// during raw world-coordinate triangulation are guarded by `rtc_applied`.
    #[inline]
    pub(super) fn transform_mesh_world(&self, mesh: &mut Mesh, transform: &Matrix4<f64>) {
        let rtc = self.rtc_offset;
        let needs_rtc = self.has_rtc_offset() && !mesh.rtc_applied;

        if needs_rtc {
            mesh.positions.chunks_exact_mut(3).for_each(|chunk| {
                let point = Point3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
                let t = transform.transform_point(&point);
                chunk[0] = (t.x - rtc.0) as f32;
                chunk[1] = (t.y - rtc.1) as f32;
                chunk[2] = (t.z - rtc.2) as f32;
            });
            mesh.rtc_applied = true;
        } else {
            mesh.positions.chunks_exact_mut(3).for_each(|chunk| {
                let point = Point3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
                let t = transform.transform_point(&point);
                chunk[0] = t.x as f32;
                chunk[1] = t.y as f32;
                chunk[2] = t.z as f32;
            });
        }

        self.transform_normals(mesh, transform);
    }

    #[inline]
    fn transform_normals(&self, mesh: &mut Mesh, transform: &Matrix4<f64>) {
        let rotation = transform.fixed_view::<3, 3>(0, 0);
        mesh.normals.chunks_exact_mut(3).for_each(|chunk| {
            let normal = Vector3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
            let t = (rotation * normal).normalize();
            chunk[0] = t.x as f32;
            chunk[1] = t.y as f32;
            chunk[2] = t.z as f32;
        });
    }
}

/// Walk a polyline-sampled curve and interpolate to a target arc length.
///
/// Returns the 3D position at `distance` along the polyline plus the unit
/// tangent of the segment containing it. The caller is expected to pass a
/// densely-sampled polyline from
/// [`ProfileProcessor::get_curve_points`][crate::profiles::ProfileProcessor::get_curve_points]
/// — the precision of the result is bounded by the sampler's spacing.
///
/// Behaviour at the extremes:
/// - `distance <= 0`: returns the first sample with the first segment's tangent.
/// - `distance >= total length`: returns the last sample with the last segment's tangent.
/// - Empty / single-sample polyline: `None` (the caller should fall back).
fn sample_polyline_at_distance(
    samples: &[Point3<f64>],
    distance: f64,
) -> Option<(Point3<f64>, Vector3<f64>)> {
    if samples.len() < 2 {
        return None;
    }

    if distance <= 0.0 {
        let tangent = (samples[1] - samples[0])
            .try_normalize(1e-12)
            .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0));
        return Some((samples[0], tangent));
    }

    let mut acc = 0.0;
    for window in samples.windows(2) {
        let a = window[0];
        let b = window[1];
        let seg = b - a;
        let len = seg.norm();
        if len < 1e-12 {
            continue;
        }
        if acc + len >= distance {
            let t = ((distance - acc) / len).clamp(0.0, 1.0);
            let position = a + seg * t;
            let tangent = (seg / len)
                .try_normalize(1e-12)
                .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0));
            return Some((position, tangent));
        }
        acc += len;
    }

    // distance past the end of the curve — clamp to last sample, last segment tangent.
    let last = samples[samples.len() - 1];
    let prev = samples[samples.len() - 2];
    let tangent = (last - prev)
        .try_normalize(1e-12)
        .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0));
    Some((last, tangent))
}

#[cfg(test)]
mod sample_polyline_tests {
    use super::*;

    #[test]
    fn samples_at_start_middle_end() {
        // Straight line along +X from (0,0,0) to (10,0,0) in 1 m segments.
        let samples: Vec<Point3<f64>> = (0..=10)
            .map(|i| Point3::new(i as f64, 0.0, 0.0))
            .collect();

        let (p0, t0) = sample_polyline_at_distance(&samples, 0.0).unwrap();
        assert!((p0 - Point3::new(0.0, 0.0, 0.0)).norm() < 1e-9);
        assert!((t0 - Vector3::new(1.0, 0.0, 0.0)).norm() < 1e-9);

        let (p5, t5) = sample_polyline_at_distance(&samples, 5.0).unwrap();
        assert!((p5 - Point3::new(5.0, 0.0, 0.0)).norm() < 1e-9);
        assert!((t5 - Vector3::new(1.0, 0.0, 0.0)).norm() < 1e-9);

        let (p10, _) = sample_polyline_at_distance(&samples, 10.0).unwrap();
        assert!((p10 - Point3::new(10.0, 0.0, 0.0)).norm() < 1e-9);
    }

    #[test]
    fn clamps_past_end() {
        let samples = vec![
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(3.0, 4.0, 0.0), // length 5
        ];
        let (p, t) = sample_polyline_at_distance(&samples, 99.0).unwrap();
        assert!((p - Point3::new(3.0, 4.0, 0.0)).norm() < 1e-9);
        assert!((t.norm() - 1.0).abs() < 1e-9, "tangent must be unit");
    }

    #[test]
    fn empty_returns_none() {
        let none = sample_polyline_at_distance(&[], 0.0);
        assert!(none.is_none());
        let single = sample_polyline_at_distance(&[Point3::new(0.0, 0.0, 0.0)], 0.0);
        assert!(single.is_none());
    }
}
