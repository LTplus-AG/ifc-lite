// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! BooleanClipping processor - CSG operations.
//!
//! Handles IfcBooleanResult and IfcBooleanClippingResult for boolean operations
//! (DIFFERENCE, UNION, INTERSECTION).

use crate::diagnostics::{BoolFailure, BoolFailureReason, BoolOp};
use crate::{
    calculate_normals, ClippingProcessor, Error, Mesh, Point2, Point3, Profile2D, Result, Vector3,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use std::cell::RefCell;

use super::brep::FacetedBrepProcessor;
use super::extrusion::ExtrudedAreaSolidProcessor;
use super::helpers::parse_axis2_placement_3d;
use super::swept::{RevolvedAreaSolidProcessor, SweptDiskSolidProcessor};
use super::tessellated::TriangulatedFaceSetProcessor;
use crate::router::GeometryProcessor;

/// Maximum recursion depth for nested boolean operations.
/// Prevents stack overflow from deeply nested IfcBooleanResult chains.
/// In WASM, the stack is limited (~1-8MB), and each recursion level uses
/// significant stack space for CSG operations.
const MAX_BOOLEAN_DEPTH: u32 = 10;

/// BooleanResult processor
/// Handles IfcBooleanResult and IfcBooleanClippingResult - CSG operations
///
/// Supports all IFC boolean operations:
/// - DIFFERENCE: Subtracts second operand from first (wall clipped by roof, openings, etc.)
///   - Uses efficient plane clipping for IfcHalfSpaceSolid operands
///   - Uses full 3D CSG for solid-solid operations (e.g., roof/slab clipping)
/// - UNION: Combines two solids into one
/// - INTERSECTION: Returns the overlapping volume of two solids
///
/// Performance notes:
/// - HalfSpaceSolid clipping is very fast (simple plane-based triangle clipping)
/// - Solid-solid CSG only invoked when actually needed (no overhead for simple geometry)
/// - Graceful fallback to first operand if CSG fails on degenerate meshes
pub struct BooleanClippingProcessor {
    schema: IfcSchema,
    /// Boolean failures recorded by this processor (the silent solid-solid
    /// skip, the polygonal-bounded half-space fallthrough, unknown operators)
    /// and drained from any internal `ClippingProcessor` instances. Drainable
    /// via [`Self::take_failures`].
    failures: RefCell<Vec<BoolFailure>>,
}

impl BooleanClippingProcessor {
    pub fn new() -> Self {
        Self {
            schema: IfcSchema::new(),
            failures: RefCell::new(Vec::new()),
        }
    }

    /// Drain the boolean-failure log accumulated since this processor was
    /// created (or the last `take_failures` call).
    pub fn take_failures(&self) -> Vec<BoolFailure> {
        std::mem::take(&mut *self.failures.borrow_mut())
    }

    fn record_failure(&self, op: BoolOp, reason: BoolFailureReason) {
        self.failures.borrow_mut().push(BoolFailure::new(op, reason));
    }

    /// Move every failure from `clipper` into this processor's log. Used
    /// after a transient `ClippingProcessor` instance is about to drop.
    fn drain_clipper_failures(&self, clipper: &ClippingProcessor) {
        let mut log = self.failures.borrow_mut();
        log.extend(clipper.take_failures());
    }

    /// Process a solid operand with depth tracking
    fn process_operand_with_depth(
        &self,
        operand: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
    ) -> Result<Mesh> {
        match operand.ifc_type {
            IfcType::IfcExtrudedAreaSolid => {
                let processor = ExtrudedAreaSolidProcessor::new(self.schema.clone());
                processor.process(operand, decoder, &self.schema)
            }
            IfcType::IfcFacetedBrep => {
                let processor = FacetedBrepProcessor::new();
                processor.process(operand, decoder, &self.schema)
            }
            IfcType::IfcTriangulatedFaceSet => {
                let processor = TriangulatedFaceSetProcessor::new();
                processor.process(operand, decoder, &self.schema)
            }
            IfcType::IfcSweptDiskSolid => {
                let processor = SweptDiskSolidProcessor::new(self.schema.clone());
                processor.process(operand, decoder, &self.schema)
            }
            IfcType::IfcRevolvedAreaSolid => {
                let processor = RevolvedAreaSolidProcessor::new(self.schema.clone());
                processor.process(operand, decoder, &self.schema)
            }
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                // Recursive case with depth tracking
                self.process_with_depth(operand, decoder, &self.schema, depth + 1)
            }
            _ => Ok(Mesh::new()),
        }
    }

    /// Parse IfcHalfSpaceSolid to get clipping plane
    /// Returns (plane_point, plane_normal, agreement_flag)
    fn parse_half_space_solid(
        &self,
        half_space: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(Point3<f64>, Vector3<f64>, bool)> {
        // IfcHalfSpaceSolid attributes:
        // 0: BaseSurface (IfcSurface - usually IfcPlane)
        // 1: AgreementFlag (boolean - true means material is on positive side)

        let surface_attr = half_space
            .get(0)
            .ok_or_else(|| Error::geometry("HalfSpaceSolid missing BaseSurface".to_string()))?;

        let surface = decoder
            .resolve_ref(surface_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve BaseSurface".to_string()))?;

        // Get agreement flag - defaults to true
        let agreement = half_space
            .get(1)
            .map(|v| match v {
                // Parser strips dots, so enum value is "T" or "F", not ".T." or ".F."
                ifc_lite_core::AttributeValue::Enum(e) => e != "F" && e != ".F.",
                _ => true,
            })
            .unwrap_or(true);

        // Parse IfcPlane
        if surface.ifc_type != IfcType::IfcPlane {
            return Err(Error::geometry(format!(
                "Expected IfcPlane for HalfSpaceSolid, got {}",
                surface.ifc_type
            )));
        }

        // IfcPlane has one attribute: Position (IfcAxis2Placement3D)
        let position_attr = surface
            .get(0)
            .ok_or_else(|| Error::geometry("IfcPlane missing Position".to_string()))?;

        let position = decoder
            .resolve_ref(position_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Plane position".to_string()))?;

        // Parse IfcAxis2Placement3D to get transformation matrix
        // The Position defines the plane's coordinate system:
        // - Location = plane point (in world coordinates)
        // - Z-axis (Axis) = plane normal (in local coordinates, needs transformation)
        let position_transform = parse_axis2_placement_3d(&position, decoder)?;

        // Plane point is the Position's Location (translation part of transform)
        let location = Point3::new(
            position_transform[(0, 3)],
            position_transform[(1, 3)],
            position_transform[(2, 3)],
        );

        // Plane normal is the Position's Z-axis transformed to world coordinates
        // Extract Z-axis from transform matrix (third column)
        let normal = Vector3::new(
            position_transform[(0, 2)],
            position_transform[(1, 2)],
            position_transform[(2, 2)],
        )
        .normalize();

        Ok((location, normal, agreement))
    }

    /// Apply half-space clipping to mesh
    fn clip_mesh_with_half_space(
        &self,
        mesh: &Mesh,
        plane_point: Point3<f64>,
        plane_normal: Vector3<f64>,
        agreement: bool,
    ) -> Result<Mesh> {
        use crate::csg::{ClippingProcessor, Plane};

        // For DIFFERENCE operation with HalfSpaceSolid:
        // - AgreementFlag=.T. means material is on positive side of plane normal
        // - AgreementFlag=.F. means material is on negative side of plane normal
        // Since we're SUBTRACTING the half-space, we keep the opposite side:
        // - If material is on positive side (agreement=true), remove positive side → keep negative side → clip_normal = plane_normal
        // - If material is on negative side (agreement=false), remove negative side → keep positive side → clip_normal = -plane_normal
        let clip_normal = if agreement {
            plane_normal // Material on positive side, remove it, keep negative side
        } else {
            -plane_normal // Material on negative side, remove it, keep positive side
        };

        let plane = Plane::new(plane_point, clip_normal);
        let processor = ClippingProcessor::new();
        processor.clip_mesh(mesh, &plane)
    }

    fn parse_polygonal_boundary_2d(
        &self,
        boundary: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Point2<f64>>> {
        if boundary.ifc_type != IfcType::IfcPolyline {
            return Err(Error::geometry(format!(
                "Expected IfcPolyline for PolygonalBoundary, got {}",
                boundary.ifc_type
            )));
        }

        let points_attr = boundary
            .get(0)
            .ok_or_else(|| Error::geometry("IfcPolyline missing Points".to_string()))?;
        let points = decoder.resolve_ref_list(points_attr)?;

        let mut contour = Vec::with_capacity(points.len());
        for point in points {
            if point.ifc_type != IfcType::IfcCartesianPoint {
                return Err(Error::geometry(format!(
                    "Expected IfcCartesianPoint in PolygonalBoundary, got {}",
                    point.ifc_type
                )));
            }

            let coords_attr = point.get(0).ok_or_else(|| {
                Error::geometry("IfcCartesianPoint missing coordinates".to_string())
            })?;
            let coords = coords_attr
                .as_list()
                .ok_or_else(|| Error::geometry("Expected point coordinate list".to_string()))?;

            let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
            let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
            contour.push(Point2::new(x, y));
        }

        if contour.len() > 1 {
            let first = contour[0];
            let last = contour[contour.len() - 1];
            if (first.x - last.x).abs() < 1e-9 && (first.y - last.y).abs() < 1e-9 {
                contour.pop();
            }
        }

        if contour.len() < 3 {
            return Err(Error::geometry(
                "PolygonalBoundary must contain at least 3 distinct points".to_string(),
            ));
        }

        Ok(contour)
    }

    fn polygon_normal(points: &[Point3<f64>]) -> Vector3<f64> {
        let mut normal = Vector3::new(0.0, 0.0, 0.0);
        for i in 0..points.len() {
            let current = points[i];
            let next = points[(i + 1) % points.len()];
            normal.x += (current.y - next.y) * (current.z + next.z);
            normal.y += (current.z - next.z) * (current.x + next.x);
            normal.z += (current.x - next.x) * (current.y + next.y);
        }

        normal
            .try_normalize(1e-12)
            .unwrap_or_else(|| Vector3::new(0.0, 0.0, 1.0))
    }

    fn build_prism_mesh(
        &self,
        contour_2d: &[Point2<f64>],
        origin: Point3<f64>,
        x_axis: Vector3<f64>,
        y_axis: Vector3<f64>,
        extrusion_dir: Vector3<f64>,
        depth: f64,
    ) -> Result<Mesh> {
        let profile = Profile2D::new(contour_2d.to_vec());
        let triangulation = profile.triangulate()?;

        let contour_world: Vec<Point3<f64>> = contour_2d
            .iter()
            .map(|p| origin + x_axis * p.x + y_axis * p.y)
            .collect();
        let tri_world: Vec<Point3<f64>> = triangulation
            .points
            .iter()
            .map(|p| origin + x_axis * p.x + y_axis * p.y)
            .collect();
        let top_world: Vec<Point3<f64>> = tri_world
            .iter()
            .map(|p| *p + extrusion_dir * depth)
            .collect();

        let mut mesh = Mesh::with_capacity(
            triangulation.points.len() * 2 + contour_world.len() * 4,
            triangulation.indices.len() * 2 + contour_world.len() * 6,
        );
        let zero = Vector3::new(0.0, 0.0, 0.0);

        let push_triangle = |mesh: &mut Mesh, a: Point3<f64>, b: Point3<f64>, c: Point3<f64>| {
            let base = mesh.vertex_count() as u32;
            mesh.add_vertex(a, zero);
            mesh.add_vertex(b, zero);
            mesh.add_vertex(c, zero);
            mesh.indices.extend_from_slice(&[base, base + 1, base + 2]);
        };

        for indices in triangulation.indices.chunks_exact(3) {
            let i0 = indices[0];
            let i1 = indices[1];
            let i2 = indices[2];

            // Base cap faces away from the extruded volume.
            push_triangle(&mut mesh, tri_world[i2], tri_world[i1], tri_world[i0]);
            // Top cap faces in the extrusion direction.
            push_triangle(&mut mesh, top_world[i0], top_world[i1], top_world[i2]);
        }

        let contour_top: Vec<Point3<f64>> = contour_world
            .iter()
            .map(|p| *p + extrusion_dir * depth)
            .collect();

        for i in 0..contour_world.len() {
            let next = (i + 1) % contour_world.len();
            let b0 = contour_world[i];
            let b1 = contour_world[next];
            let t0 = contour_top[i];
            let t1 = contour_top[next];

            push_triangle(&mut mesh, b0, b1, t1);
            push_triangle(&mut mesh, b0, t1, t0);
        }

        calculate_normals(&mut mesh);
        Ok(mesh)
    }

    fn build_polygonal_bounded_half_space_mesh(
        &self,
        half_space: &DecodedEntity,
        decoder: &mut EntityDecoder,
        host_mesh: &Mesh,
        plane_normal: Vector3<f64>,
        agreement: bool,
    ) -> Result<Mesh> {
        let position_attr = half_space.get(2).ok_or_else(|| {
            Error::geometry("PolygonalBoundedHalfSpace missing Position".to_string())
        })?;
        let position = decoder.resolve_ref(position_attr)?.ok_or_else(|| {
            Error::geometry("Failed to resolve bounded half-space Position".to_string())
        })?;
        let transform = parse_axis2_placement_3d(&position, decoder)?;

        let boundary_attr = half_space.get(3).ok_or_else(|| {
            Error::geometry("PolygonalBoundedHalfSpace missing PolygonalBoundary".to_string())
        })?;
        let boundary = decoder
            .resolve_ref(boundary_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve PolygonalBoundary".to_string()))?;

        let mut contour_2d = self.parse_polygonal_boundary_2d(&boundary, decoder)?;

        let origin = Point3::new(transform[(0, 3)], transform[(1, 3)], transform[(2, 3)]);
        let x_axis =
            Vector3::new(transform[(0, 0)], transform[(1, 0)], transform[(2, 0)]).normalize();
        let y_axis =
            Vector3::new(transform[(0, 1)], transform[(1, 1)], transform[(2, 1)]).normalize();

        let mut contour_world: Vec<Point3<f64>> = contour_2d
            .iter()
            .map(|p| origin + x_axis * p.x + y_axis * p.y)
            .collect();

        // Extrude along the side of the plane that is removed by the boolean difference.
        let extrusion_dir = if agreement {
            -plane_normal
        } else {
            plane_normal
        }
        .normalize();

        if Self::polygon_normal(&contour_world).dot(&extrusion_dir) < 0.0 {
            contour_2d.reverse();
            contour_world.reverse();
        }

        let (host_min, host_max) = host_mesh.bounds();
        let host_corners = [
            Point3::new(host_min.x as f64, host_min.y as f64, host_min.z as f64),
            Point3::new(host_max.x as f64, host_min.y as f64, host_min.z as f64),
            Point3::new(host_min.x as f64, host_max.y as f64, host_min.z as f64),
            Point3::new(host_max.x as f64, host_max.y as f64, host_min.z as f64),
            Point3::new(host_min.x as f64, host_min.y as f64, host_max.z as f64),
            Point3::new(host_max.x as f64, host_min.y as f64, host_max.z as f64),
            Point3::new(host_min.x as f64, host_max.y as f64, host_max.z as f64),
            Point3::new(host_max.x as f64, host_max.y as f64, host_max.z as f64),
        ];
        let host_diag = ((host_max.x - host_min.x) as f64)
            .hypot((host_max.y - host_min.y) as f64)
            .hypot((host_max.z - host_min.z) as f64);
        let max_projection = host_corners
            .iter()
            .map(|corner| (corner - origin).dot(&extrusion_dir))
            .fold(0.0_f64, f64::max);
        let depth = max_projection.max(host_diag) + 1.0;

        self.build_prism_mesh(&contour_2d, origin, x_axis, y_axis, extrusion_dir, depth)
    }

    /// Internal processing with depth tracking to prevent stack overflow
    fn process_with_depth(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        depth: u32,
    ) -> Result<Mesh> {
        // Depth limit to prevent stack overflow from deeply nested boolean chains
        if depth > MAX_BOOLEAN_DEPTH {
            return Err(Error::geometry(format!(
                "Boolean nesting depth {} exceeds limit {}",
                depth, MAX_BOOLEAN_DEPTH
            )));
        }

        // IfcBooleanResult attributes:
        // 0: Operator (.DIFFERENCE., .UNION., .INTERSECTION.)
        // 1: FirstOperand (base geometry)
        // 2: SecondOperand (clipping geometry)

        // Get operator
        let operator = entity
            .get(0)
            .and_then(|v| match v {
                ifc_lite_core::AttributeValue::Enum(e) => Some(e.as_str()),
                _ => None,
            })
            .unwrap_or(".DIFFERENCE.");

        // Get first operand (base geometry)
        let first_operand_attr = entity
            .get(1)
            .ok_or_else(|| Error::geometry("BooleanResult missing FirstOperand".to_string()))?;

        let first_operand = decoder
            .resolve_ref(first_operand_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve FirstOperand".to_string()))?;

        // Process first operand to get base mesh
        let mesh = self.process_operand_with_depth(&first_operand, decoder, depth)?;

        if mesh.is_empty() {
            return Ok(mesh);
        }

        // Get second operand
        let second_operand_attr = entity
            .get(2)
            .ok_or_else(|| Error::geometry("BooleanResult missing SecondOperand".to_string()))?;

        let second_operand = decoder
            .resolve_ref(second_operand_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve SecondOperand".to_string()))?;

        // Handle DIFFERENCE operation
        // Note: Parser may strip dots from enum values, so check both forms
        if operator == ".DIFFERENCE." || operator == "DIFFERENCE" {
            // Check if second operand is a half-space solid (simple or polygonally bounded)
            if second_operand.ifc_type == IfcType::IfcHalfSpaceSolid {
                // Simple half-space: use plane clipping
                let (plane_point, plane_normal, agreement) =
                    self.parse_half_space_solid(&second_operand, decoder)?;
                return self.clip_mesh_with_half_space(&mesh, plane_point, plane_normal, agreement);
            }

            if second_operand.ifc_type == IfcType::IfcPolygonalBoundedHalfSpace {
                let (plane_point, plane_normal, agreement) =
                    self.parse_half_space_solid(&second_operand, decoder)?;
                if let Ok(bound_mesh) = self.build_polygonal_bounded_half_space_mesh(
                    &second_operand,
                    decoder,
                    &mesh,
                    plane_normal,
                    agreement,
                ) {
                    let clipper = ClippingProcessor::new();
                    let subtract_result = clipper.subtract_mesh(&mesh, &bound_mesh);
                    self.drain_clipper_failures(&clipper);
                    if let Ok(clipped) = subtract_result {
                        return Ok(clipped);
                    }
                }

                // Bounded prism subtract failed (or its build did). The
                // unbounded plane clip *is* applied, but it's a strict
                // superset of the bounded cut — the polygonal boundary is
                // silently dropped. Flag so callers can surface the loss.
                self.record_failure(
                    BoolOp::Difference,
                    BoolFailureReason::PolygonalBoundedHalfSpaceFallback,
                );
                return self.clip_mesh_with_half_space(&mesh, plane_point, plane_normal, agreement);
            }

            // Solid-solid difference. Under `manifold-csg` we route through
            // the Manifold kernel; without the feature the legacy BSP path
            // can stack-overflow on arbitrary solid combinations so we
            // continue to skip and record `SolidSolidDifferenceSkipped`.
            #[cfg(feature = "manifold-csg")]
            {
                let second_mesh =
                    self.process_operand_with_depth(&second_operand, decoder, depth)?;
                if second_mesh.is_empty() {
                    self.record_failure(BoolOp::Difference, BoolFailureReason::EmptyOperand);
                    return Ok(mesh);
                }
                let clipper = ClippingProcessor::new();
                let result = clipper.subtract_mesh(&mesh, &second_mesh);
                self.drain_clipper_failures(&clipper);
                return result;
            }
            #[cfg(not(feature = "manifold-csg"))]
            {
                self.record_failure(
                    BoolOp::Difference,
                    BoolFailureReason::SolidSolidDifferenceSkipped,
                );
                return Ok(mesh);
            }
        }

        // Handle UNION operation. Under `manifold-csg` this is a real CSG
        // union (overlap removed). Without the feature the legacy path
        // mesh-merges (overlap retained) and records the failure so callers
        // can flag the loss.
        if operator == ".UNION." || operator == "UNION" {
            let second_mesh = self.process_operand_with_depth(&second_operand, decoder, depth)?;
            if second_mesh.is_empty() {
                return Ok(mesh);
            }
            #[cfg(feature = "manifold-csg")]
            {
                let clipper = ClippingProcessor::new();
                let result = clipper.union_mesh(&mesh, &second_mesh);
                self.drain_clipper_failures(&clipper);
                return result;
            }
            #[cfg(not(feature = "manifold-csg"))]
            {
                self.record_failure(
                    BoolOp::Union,
                    BoolFailureReason::KernelError(
                        "IfcBooleanResult.UNION uses mesh-merge (no overlap removal)".into(),
                    ),
                );
                let mut merged = mesh;
                merged.merge(&second_mesh);
                return Ok(merged);
            }
        }

        // Handle INTERSECTION operation. Under `manifold-csg` this returns
        // a real intersection volume; the legacy path can't compute it
        // safely (BSP stack risk) so it returns empty and records.
        if operator == ".INTERSECTION." || operator == "INTERSECTION" {
            #[cfg(feature = "manifold-csg")]
            {
                let second_mesh =
                    self.process_operand_with_depth(&second_operand, decoder, depth)?;
                if second_mesh.is_empty() {
                    return Ok(Mesh::new());
                }
                let clipper = ClippingProcessor::new();
                let result = clipper.intersection_mesh(&mesh, &second_mesh);
                self.drain_clipper_failures(&clipper);
                return result;
            }
            #[cfg(not(feature = "manifold-csg"))]
            {
                self.record_failure(
                    BoolOp::Intersection,
                    BoolFailureReason::KernelError(
                        "IfcBooleanResult.INTERSECTION not implemented (returns empty)".into(),
                    ),
                );
                return Ok(Mesh::new());
            }
        }

        self.record_failure(
            BoolOp::Difference,
            BoolFailureReason::UnknownBooleanOperator(operator.to_string()),
        );
        Ok(mesh)
    }
}

impl GeometryProcessor for BooleanClippingProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
    ) -> Result<Mesh> {
        self.process_with_depth(entity, decoder, schema, 0)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcBooleanResult, IfcType::IfcBooleanClippingResult]
    }
}

impl Default for BooleanClippingProcessor {
    fn default() -> Self {
        Self::new()
    }
}
