// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! BooleanClipping processor - CSG operations.
//!
//! Handles IfcBooleanResult and IfcBooleanClippingResult for boolean operations
//! (DIFFERENCE, UNION, INTERSECTION).

use crate::diagnostics::{BoolFailure, BoolFailureReason, BoolOp};
use crate::{
    calculate_normals, ClippingProcessor, Error, Mesh, Point2, Point3, Profile2D, Result,
    TessellationQuality, Vector3,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use std::cell::RefCell;

use super::brep::FacetedBrepProcessor;
use super::csg_primitive::{BlockProcessor, CsgSolidProcessor};
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

    /// If a DIFFERENCE clip emptied a non-empty host **and** the cutter's
    /// plane is coincident with one of the host's bounding-box faces,
    /// revert to the host and record the loss. The coincidence test is
    /// what keeps this from rendering geometry the model explicitly
    /// removed: a half-space deliberately placed far from the host so it
    /// engulfs the body (e.g. a demolition-phase cutter) still produces
    /// the correct empty mesh because no host face touches that plane.
    /// Only the Revit IFC2x3 "top-trim at exactly the wall top" pattern
    /// — issue #821 TallBuilding.ifc walls #615, #1297, #2401 and similar
    /// Revit exports where the spec-correct cut would erase the wall —
    /// hits the fallback.
    fn guard_against_full_host_removal(
        &self,
        host: Mesh,
        result: Mesh,
        plane_point: Point3<f64>,
        plane_normal: Vector3<f64>,
    ) -> Mesh {
        if host.is_empty() || !result.is_empty() {
            return result;
        }
        if !plane_is_coincident_with_host_face(&host, plane_point, plane_normal) {
            // Spec-correct full removal — respect the author's intent.
            return result;
        }
        self.record_failure(BoolOp::Difference, BoolFailureReason::DifferenceEmptiedHost);
        host
    }

    /// Process a solid operand with depth tracking
    fn process_operand_with_depth(
        &self,
        operand: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        match operand.ifc_type {
            IfcType::IfcExtrudedAreaSolid => {
                let processor = ExtrudedAreaSolidProcessor::new(self.schema.clone());
                processor.process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcFacetedBrep => {
                let processor = FacetedBrepProcessor::new();
                processor.process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcTriangulatedFaceSet => {
                let processor = TriangulatedFaceSetProcessor::new();
                processor.process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcSweptDiskSolid => {
                let processor = SweptDiskSolidProcessor::new(self.schema.clone());
                processor.process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcRevolvedAreaSolid => {
                let processor = RevolvedAreaSolidProcessor::new(self.schema.clone());
                processor.process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcBlock => {
                BlockProcessor::new().process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcCsgSolid => {
                CsgSolidProcessor::new().process(operand, decoder, &self.schema, quality)
            }
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                // Recursive case with depth tracking
                self.process_with_depth(operand, decoder, &self.schema, depth + 1, quality)
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

    fn build_polygonal_bounded_half_space_mesh(
        &self,
        half_space: &DecodedEntity,
        decoder: &mut EntityDecoder,
        host_mesh: &Mesh,
        plane_point: Point3<f64>,
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

        let contour_2d = self.parse_polygonal_boundary_2d(&boundary, decoder)?;

        let origin = Point3::new(transform[(0, 3)], transform[(1, 3)], transform[(2, 3)]);
        let x_axis =
            Vector3::new(transform[(0, 0)], transform[(1, 0)], transform[(2, 0)]).normalize();
        let y_axis =
            Vector3::new(transform[(0, 1)], transform[(1, 1)], transform[(2, 1)]).normalize();
        // Per IFC spec (IfcPolygonalBoundedHalfSpace): the polygon is in
        // Position's XY plane and is extruded INFINITELY along Position's
        // Z-axis to form an unbounded prism. The bounded half-space is the
        // intersection of that prism with the IfcHalfSpaceSolid.
        let z_axis =
            Vector3::new(transform[(0, 2)], transform[(1, 2)], transform[(2, 2)]).normalize();

        // The half-space "material" side (the side we SUBTRACT from the host)
        // depends on AgreementFlag. Per IFC spec, AgreementFlag=TRUE means the
        // surface normal points AWAY from the material — so material is on
        // the NEGATIVE normal side. AgreementFlag=FALSE flips it.
        let material_side_dir = if agreement {
            -plane_normal
        } else {
            plane_normal
        }
        .normalize();

        // The prism is extruded perpendicular to the polygon plane (along
        // Position.Z), but ONLY toward the material side of the base surface —
        // the side this DIFFERENCE removes. A spec-correct
        // IfcPolygonalBoundedHalfSpace prism is infinite along ±Position.Z and
        // then intersected with the half-space; our one-directional prism
        // approximates that, so it MUST point at the material side. Position.Z
        // is authored independently of AgreementFlag (the duplex "Party Wall"
        // clips author Position.Z parallel to +normal while AgreementFlag puts
        // the material on -normal), so flip its sign when it points away from
        // the material side. The cross-section stays perpendicular to
        // Position.Z, preserving the tilted-cutter fix (#583).
        let ext_dir = if z_axis.dot(&material_side_dir) >= 0.0 {
            z_axis
        } else {
            -z_axis
        };

        // Project each polygon vertex from its position in Position's XY
        // plane onto the slope plane along Position's Z-axis. This yields a
        // (possibly tilted) polygon that lies ON the slope plane and forms
        // the BASE cap of the bounded half-space prism.
        //
        // For a polygon vertex P0 (at z = 0 in Position frame, world = origin
        // + x_axis*u + y_axis*v), the line P0 + t*z_axis intersects the slope
        // plane when (P0 + t*z_axis - plane_point) · plane_normal = 0:
        //
        //     t = ((plane_point - P0) · plane_normal) / (z_axis · plane_normal)
        //
        // If z_axis is parallel to the plane, projection fails and we fall
        // back to placing the base cap at the polygon's natural location.
        let z_dot_n = z_axis.dot(&plane_normal);
        let mut base_world: Vec<Point3<f64>> = contour_2d
            .iter()
            .map(|p| origin + x_axis * p.x + y_axis * p.y)
            .collect();
        if z_dot_n.abs() > 1e-9 {
            for (point, contour_pt) in base_world.iter_mut().zip(contour_2d.iter()) {
                let p0 = origin + x_axis * contour_pt.x + y_axis * contour_pt.y;
                let t = (plane_point - p0).dot(&plane_normal) / z_dot_n;
                *point = p0 + z_axis * t;
            }
        }

        // Per IFC 4.3 IfcPolygonalBoundedHalfSpace spec
        // (https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcPolygonalBoundedHalfSpace.htm):
        //
        //   "[The polygonal boundary is] extruded perpendicular to the XY
        //    plane of the position coordinate system, that is, into the
        //    direction of the positive Z axis defined by the Position
        //    attribute."
        //
        // We must extrude along the Position Z-axis (`z_axis`), NOT along
        // `material_side_dir`. When the slope plane is tilted (e.g. the
        // ~22°-tilted chained cutters on AC20-Institute-Var-2 walls,
        // issue #583), extruding along material_side_dir produces a
        // sheared prism whose XY footprint at the host's level no longer
        // covers the wall's full thickness. Walls' back faces project
        // outside the polygon and stay un-clipped — confirmed against
        // IfcOpenShell on AC20-Institute-Var-2 Wand-010 (#228278):
        // pre-fix we emitted 65 tris with z=[9.0, 11.7] vs IOS's 28
        // tris with z=[9.0, 10.33]; post-fix the bounds match.
        //
        // Depth covers the host along Position.Z (with a host-diagonal
        // floor so a small host with a large polygon still produces a
        // prism that fully contains the host).
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
        let base_centroid: Point3<f64> = if base_world.is_empty() {
            origin
        } else {
            let sum = base_world
                .iter()
                .fold(Vector3::zeros(), |acc, p| acc + p.coords);
            Point3::from(sum / base_world.len() as f64)
        };
        let max_projection_z = host_corners
            .iter()
            .map(|corner| (corner - base_centroid).dot(&ext_dir))
            .fold(0.0_f64, f64::max);
        let depth = max_projection_z.max(host_diag) + 1.0;

        // Top cap = base cap translated along the material-side extrusion
        // direction by `depth`.
        let top_world: Vec<Point3<f64>> =
            base_world.iter().map(|p| *p + ext_dir * depth).collect();

        // Winding: build_tilted_prism_mesh REVERSES the bottom cap
        // (triangles emitted in reverse order) and KEEPS the top cap.
        // For a closed solid with outward-facing caps:
        //   - Bottom cap outward normal: -ext_dir (pointing OUT of the prism,
        //     whose interior is on the +ext_dir side of the slope plane)
        //   - Top cap outward normal: +ext_dir (pointing OUT)
        // After the in-builder reversal, the bottom cap inherits the
        // polygon's REVERSED normal. We need REVERSED == -ext_dir, so the
        // polygon's natural normal must be +ext_dir. Reverse the polygon
        // ONLY if its natural normal currently points in -ext_dir.
        let mut base = base_world;
        let mut top = top_world;
        let mut contour_2d = contour_2d;
        if Self::polygon_normal(&base).dot(&ext_dir) < 0.0 {
            base.reverse();
            top.reverse();
            contour_2d.reverse();
        }

        self.build_tilted_prism_mesh(&contour_2d, &base, &top)
    }

    /// Build a closed prism mesh given a parameterising 2D polygon (used
    /// only for triangulating the caps) and the matching arrays of world-
    /// space base and top vertices. `base[i]` and `top[i]` must correspond
    /// to `contour_2d[i]`. Caps are tessellated using `Profile2D::triangulate`
    /// on `contour_2d`, then each tri is emitted with vertices from `base`
    /// (bottom) and `top` (top). Side walls connect successive base/top
    /// pairs into quads.
    fn build_tilted_prism_mesh(
        &self,
        contour_2d: &[Point2<f64>],
        base_world: &[Point3<f64>],
        top_world: &[Point3<f64>],
    ) -> Result<Mesh> {
        if base_world.len() != contour_2d.len() || top_world.len() != contour_2d.len() {
            return Err(Error::geometry(
                "Polygonal bounded half-space cap arrays must match contour length"
                    .to_string(),
            ));
        }

        let profile = Profile2D::new(contour_2d.to_vec());
        let triangulation = profile.triangulate()?;

        // Map each triangulation vertex back to the corresponding world-space
        // base/top vertex. `triangulation.points` contains the contour
        // vertices in the same order they were supplied (earcutr does not
        // permute the inputs for a simple polygon), so positional indexing
        // works as long as we account for any re-ordering by re-finding the
        // closest contour point if needed.
        //
        // In practice, triangulation.points == contour_2d for our inputs,
        // so we look up each tri-point by index identity into contour_2d.
        let mut tri_to_contour: Vec<usize> = Vec::with_capacity(triangulation.points.len());
        for tp in &triangulation.points {
            // Find the contour vertex whose 2D coordinates match this
            // triangulation vertex (within a small epsilon).
            let mut best = 0usize;
            let mut best_d = f64::INFINITY;
            for (i, cp) in contour_2d.iter().enumerate() {
                let d = (tp.x - cp.x).powi(2) + (tp.y - cp.y).powi(2);
                if d < best_d {
                    best_d = d;
                    best = i;
                }
            }
            tri_to_contour.push(best);
        }

        let mut mesh = Mesh::with_capacity(
            base_world.len() * 2 + contour_2d.len() * 4,
            triangulation.indices.len() * 2 + contour_2d.len() * 6,
        );
        let zero = Vector3::new(0.0, 0.0, 0.0);

        let push_triangle = |mesh: &mut Mesh, a: Point3<f64>, b: Point3<f64>, c: Point3<f64>| {
            let base_idx = mesh.vertex_count() as u32;
            mesh.add_vertex(a, zero);
            mesh.add_vertex(b, zero);
            mesh.add_vertex(c, zero);
            mesh.indices.extend_from_slice(&[base_idx, base_idx + 1, base_idx + 2]);
        };

        for indices in triangulation.indices.chunks_exact(3) {
            let i0 = tri_to_contour[indices[0]];
            let i1 = tri_to_contour[indices[1]];
            let i2 = tri_to_contour[indices[2]];

            // Base cap faces away from the extruded volume.
            push_triangle(&mut mesh, base_world[i2], base_world[i1], base_world[i0]);
            // Top cap faces in the extrusion direction.
            push_triangle(&mut mesh, top_world[i0], top_world[i1], top_world[i2]);
        }

        for i in 0..base_world.len() {
            let next = (i + 1) % base_world.len();
            let b0 = base_world[i];
            let b1 = base_world[next];
            let t0 = top_world[i];
            let t1 = top_world[next];

            push_triangle(&mut mesh, b0, b1, t1);
            push_triangle(&mut mesh, b0, t1, t0);
        }

        calculate_normals(&mut mesh);
        Ok(mesh)
    }

    /// Walk the left-spine of a chained
    /// `IfcBooleanClippingResult(.DIFFERENCE., x, polygonalBoundedHalfSpace)`
    /// pattern (typical for gable walls clipped by a segmented roof) and
    /// collect every consecutive `IfcPolygonalBoundedHalfSpace` cutter, plus
    /// the base solid the chain bottoms out on.
    ///
    /// Returns `(base_entity, cutters)` with `cutters` ordered innermost-first.
    /// Consumed by [`Self::try_union_polygonal_chain`], which unions the cutter
    /// prisms (a true CSG union — overlap-safe, unlike the old mesh-*merge*
    /// batching) and subtracts once. See that method for why a single unioned
    /// subtract beats sequential subtraction here (issue #960: seam slivers +
    /// deep-chain depth-limit drops).
    #[cfg(feature = "manifold-csg")]
    fn collect_polygonal_chain(
        &self,
        entity: DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(DecodedEntity, Vec<DecodedEntity>)> {
        let mut chain: Vec<DecodedEntity> = Vec::new();
        let mut current = entity;
        loop {
            if !matches!(
                current.ifc_type,
                IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult
            ) {
                break;
            }
            // Operator must be DIFFERENCE.
            let op = current
                .get(0)
                .and_then(|v| match v {
                    ifc_lite_core::AttributeValue::Enum(e) => Some(e.as_str().to_string()),
                    _ => None,
                })
                .unwrap_or_else(|| ".DIFFERENCE.".to_string());
            if op != ".DIFFERENCE." && op != "DIFFERENCE" {
                break;
            }
            let Some(second_attr) = current.get(2) else { break };
            let Ok(Some(second)) = decoder.resolve_ref(second_attr) else { break };
            if second.ifc_type != IfcType::IfcPolygonalBoundedHalfSpace {
                break;
            }
            chain.push(second);
            let Some(first_attr) = current.get(1) else { break };
            let Ok(Some(first)) = decoder.resolve_ref(first_attr) else { break };
            current = first;
        }
        // Reverse so chain[0] is the innermost (first-applied) clip.
        chain.reverse();
        Ok((current, chain))
    }

    /// Resolve a left-deep chain of
    /// `IfcBooleanClippingResult(.DIFFERENCE., x, IfcPolygonalBoundedHalfSpace)`
    /// clips by unioning every cutter prism into one solid and subtracting it
    /// from the base in a single operation. See the call site in
    /// [`Self::process_with_depth`] for the full rationale (issue #960: seam
    /// slivers + deep-chain depth-limit drops).
    ///
    /// Returns `Ok(None)` — defer to the standard sequential path — when the
    /// chain has fewer than two PBHS cutters, when a cutter prism fails to
    /// build, or when batching can't be proven safe (a full-cross-section
    /// cutter that needs the per-cutter unbounded-plane fallback, or a CSG
    /// union that silently under-removes).
    ///
    /// Only compiled with `manifold-csg`: it relies on a true CSG union of the
    /// cutter prisms, which the BSP fallback can't guarantee.
    #[cfg(feature = "manifold-csg")]
    fn try_union_polygonal_chain(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        depth: u32,
        quality: TessellationQuality,
    ) -> Result<Option<Mesh>> {
        let (base_entity, cutters) = self.collect_polygonal_chain(entity.clone(), decoder)?;
        if cutters.len() < 2 {
            return Ok(None);
        }

        // Process the base solid (the innermost first-operand). The chain is
        // walked iteratively above, so a 12-cutter chain reaches here at the
        // SAME `depth` as a 2-cutter one — the recursion-depth limit can't drop
        // it.
        let base_mesh = self.process_operand_with_depth(&base_entity, decoder, depth, quality)?;
        if base_mesh.is_empty() {
            return Ok(Some(base_mesh));
        }

        // Build each cutter prism (bounds-clamped to the base).
        let mut prisms: Vec<Mesh> = Vec::with_capacity(cutters.len());
        for cutter in &cutters {
            let (plane_point, plane_normal, agreement) =
                self.parse_half_space_solid(cutter, decoder)?;
            match self.build_polygonal_bounded_half_space_mesh(
                cutter,
                decoder,
                &base_mesh,
                plane_point,
                plane_normal,
                agreement,
            ) {
                Ok(prism) if !prism.is_empty() => prisms.push(prism),
                // A cutter we can't build a prism for would be silently dropped
                // here; defer to the sequential path, which records the loss as
                // `PolygonalBoundedHalfSpaceFallback`.
                _ => return Ok(None),
            }
        }

        let clipper = ClippingProcessor::new();

        // Per-cutter trial subtracts serve two roles:
        //   * reject the chain if any single cutter is degenerate (a full-
        //     cross-section coincident-face clip whose bounded subtract is
        //     fragile — duplex.ifc "Party Wall" #4287/#4399, which the
        //     sequential path rescues via its bounded→unbounded fallback), and
        //   * record the intersection of every single-cutter result's bounds.
        //     The true answer (base minus the union of ALL cutters) is a subset
        //     of each single-cutter result, so its bounds can't exceed that
        //     intersection. If the unioned subtract below pokes outside it, the
        //     CSG union silently under-removed (manifold does this for near-
        //     coincident/duplicate cutters) and must not be trusted.
        let mut tight_min = Point3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
        let mut tight_max = Point3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
        for prism in &prisms {
            let trial = match clipper.subtract_mesh(&base_mesh, prism) {
                Ok(m) if !m.is_empty() => m,
                // Empty or errored single cut — the sequential path's per-cutter
                // fallback handles it better than a batched union would.
                _ => {
                    let _ = clipper.take_failures();
                    return Ok(None);
                }
            };
            if ClippingProcessor::difference_result_looks_degenerate(&base_mesh, &trial) {
                let _ = clipper.take_failures();
                return Ok(None);
            }
            let (tmn, tmx) = trial.bounds();
            tight_min = Point3::new(
                tight_min.x.max(tmn.x),
                tight_min.y.max(tmn.y),
                tight_min.z.max(tmn.z),
            );
            tight_max = Point3::new(
                tight_max.x.min(tmx.x),
                tight_max.y.min(tmx.y),
                tight_max.z.min(tmx.z),
            );
        }
        let _ = clipper.take_failures();

        // Every cutter is a clean partial cut: union them (a true CSG union, so
        // abutting roof segments share no internal seam) and subtract once. This
        // is what eliminates the zero-thickness seam fins that sequential
        // subtraction leaves behind. A union failure must defer to the
        // sequential path (like every other guard here), never bubble up — a
        // bubbled error would drop the whole wall instead of falling back.
        let combined = match clipper.union_meshes(&prisms) {
            Ok(m) if !m.is_empty() => m,
            _ => {
                let _ = clipper.take_failures();
                return Ok(None);
            }
        };
        let result = clipper.subtract_mesh(&base_mesh, &combined);
        self.drain_clipper_failures(&clipper);
        let clipped = match result {
            Ok(m)
                if !m.is_empty()
                    && !ClippingProcessor::difference_result_looks_degenerate(&base_mesh, &m) =>
            {
                m
            }
            // Kernel error or a degenerate union result — fall back to the
            // sequential per-cutter path.
            _ => return Ok(None),
        };

        // Reject a silently under-removing union: the result must fit inside the
        // intersection of the single-cutter result bounds (tolerance scaled to
        // the host size). If it pokes outside, the union dropped a cut — defer
        // to sequential. (duplex.ifc: a near-coincident cutter pair unions to
        // less than either alone.)
        let (rmn, rmx) = clipped.bounds();
        let diag = (tight_max.x - tight_min.x)
            .hypot(tight_max.y - tight_min.y)
            .hypot(tight_max.z - tight_min.z);
        let tol = (diag * 1e-3).max(1e-4);
        let under_removed = rmx.x > tight_max.x + tol
            || rmx.y > tight_max.y + tol
            || rmx.z > tight_max.z + tol
            || rmn.x < tight_min.x - tol
            || rmn.y < tight_min.y - tol
            || rmn.z < tight_min.z - tol;
        if under_removed {
            return Ok(None);
        }
        Ok(Some(clipped))
    }

    /// Internal processing with depth tracking to prevent stack overflow
    fn process_with_depth(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        depth: u32,
        quality: TessellationQuality,
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

        // A left-deep chain of `IfcBooleanClippingResult(.DIFFERENCE., x,
        // IfcPolygonalBoundedHalfSpace)` clips — the canonical "gable wall
        // trimmed by a segmented roof" pattern — is resolved by unioning all
        // cutter prisms into one solid and subtracting it once, rather than
        // applying each cutter sequentially. Two reasons (issue #960,
        // House.ifc):
        //
        //  1. **No seam slivers.** Sequentially subtracting two prisms that
        //     abut along a shared edge (adjacent roof segments meeting at a
        //     hip/valley) leaves the host material exactly on the seam as a
        //     zero-thickness, full-height fin — rendered double-sided, it is a
        //     visible wall sliver poking through the roof. A real CSG *union*
        //     dissolves the shared face, so the single subtract leaves nothing
        //     behind. (This is NOT the old mesh-*merge* batching that produced
        //     non-manifold cutters — `union_meshes` runs a true CSG union,
        //     which handles overlapping/duplicate cutters correctly.)
        //  2. **No depth-limit drops.** The chain is walked iteratively, so a
        //     wall clipped by 12+ roof planes no longer blows MAX_BOOLEAN_DEPTH
        //     and vanishes (House.ifc walls #4148/#2797/#5904).
        //
        // `try_union_polygonal_chain` returns `None` (fall through to the
        // sequential path below) whenever batching isn't provably safe, so the
        // per-cutter bounded→unbounded fallback still rescues full-cross-section
        // clips (duplex.ifc "Party Wall"). Verified mm-identical to IfcOpenShell
        // on all five reported House.ifc walls.
        //
        // Gated on `manifold-csg`: the whole approach hinges on a *true* CSG
        // union of the cutter prisms. The legacy BSP `union_mesh` can fall back
        // to a non-manifold mesh-merge, which neither dissolves the seam nor is
        // safe to subtract — so without Manifold (the BSP server build) we keep
        // the unchanged sequential path rather than risk a worse result.
        #[cfg(feature = "manifold-csg")]
        if operator == ".DIFFERENCE." || operator == "DIFFERENCE" {
            if let Some(result) = self.try_union_polygonal_chain(entity, decoder, depth, quality)? {
                return Ok(result);
            }
        }

        // NOTE: a previous version had a "fast path for chained polygonal-
        // bounded half-space clips" here that mesh-merged every cutter in
        // the chain into one combined mesh and ran a single BSP CSG op.
        // That batching is incorrect when chained cutter polygons OVERLAP
        // or DUPLICATE — the mesh-merge of two closed solids occupying
        // the same volume is non-manifold by construction, and BSP CSG on
        // a non-manifold cutter produces sliver artefacts (issue #583
        // AC20-Institute-Var-2 Wand-010, which has 4 chained cutters
        // including an exact duplicate at x=[17,25]).
        //
        // The reference implementations both handle this differently:
        //   - web-ifc:      strictly sequential. One CSG per IfcBooleanResult
        //                   node, recursing first-operand bottom-up.
        //   - ifcopenshell: batches via OCCT's topological CSG (handles
        //                   overlap natively) up to 8 operands, then falls
        //                   back to sequential past that.
        //
        // We can't do OCCT-style topological CSG in our BSP/Manifold
        // mesh-CSG kernel, so we follow web-ifc: SEQUENTIAL through the
        // standard recursive path below. The per-step cutter is always a
        // single closed manifold prism, so the non-manifold-cutter root
        // cause is structurally eliminated.
        //
        // Performance: N CSG ops instead of 1 for chains of length N, but
        // each op runs on a SMALL single-cutter mesh (one polygon prism =
        // ~10-20 tris) rather than the combined N-cutter mesh, so wall-
        // clock cost is comparable. CSG cost scales with operand polygon
        // count, not operation count.
        //
        // See docs/research/csg-clipping-fidelity.md for the full
        // side-by-side comparison with the reference implementations.

        // Get first operand (base geometry)
        let first_operand_attr = entity
            .get(1)
            .ok_or_else(|| Error::geometry("BooleanResult missing FirstOperand".to_string()))?;

        let first_operand = decoder
            .resolve_ref(first_operand_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve FirstOperand".to_string()))?;

        // Process first operand to get base mesh
        let mesh = self.process_operand_with_depth(&first_operand, decoder, depth, quality)?;

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
                let clipped =
                    self.clip_mesh_with_half_space(&mesh, plane_point, plane_normal, agreement)?;
                return Ok(self.guard_against_full_host_removal(
                    mesh,
                    clipped,
                    plane_point,
                    plane_normal,
                ));
            }

            if second_operand.ifc_type == IfcType::IfcPolygonalBoundedHalfSpace {
                let (plane_point, plane_normal, agreement) =
                    self.parse_half_space_solid(&second_operand, decoder)?;
                if let Ok(bound_mesh) = self.build_polygonal_bounded_half_space_mesh(
                    &second_operand,
                    decoder,
                    &mesh,
                    plane_point,
                    plane_normal,
                    agreement,
                ) {
                    let clipper = ClippingProcessor::new();
                    let subtract_result = clipper.subtract_mesh(&mesh, &bound_mesh);
                    self.drain_clipper_failures(&clipper);
                    if let Ok(clipped) = subtract_result {
                        // The bounded-prism subtract is fragile on coincident
                        // faces: when the clip polygon spans the full host
                        // cross-section, the prism's in-plane side walls land
                        // exactly on the host's side faces and the CSG kernel
                        // can collapse the host to a near-empty sliver
                        // (duplex.ifc "Party Wall" segments #4287/#4399 —
                        // 12-tri box → 2-tri quad on the legacy BSP kernel the
                        // native server uses). When the result looks degenerate
                        // we fall through to the robust unbounded plane clip
                        // below: a strict superset of the bounded cut that is
                        // exactly correct whenever the polygon already covers
                        // the host's projected cross-section.
                        if !ClippingProcessor::difference_result_looks_degenerate(&mesh, &clipped) {
                            return Ok(self.guard_against_full_host_removal(
                                mesh,
                                clipped,
                                plane_point,
                                plane_normal,
                            ));
                        }
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
                let clipped =
                    self.clip_mesh_with_half_space(&mesh, plane_point, plane_normal, agreement)?;
                return Ok(self.guard_against_full_host_removal(
                    mesh,
                    clipped,
                    plane_point,
                    plane_normal,
                ));
            }

            // Solid-solid difference. Under `manifold-csg` Manifold handles
            // arbitrary operand sizes; without the feature we fall back to
            // the legacy BSP path in `ClippingProcessor::subtract_mesh`,
            // which has its own `can_run_csg_operation` polygon cap and
            // records `OperandTooLarge` (returning the un-cut host) when an
            // operand exceeds it. That's the correct guardrail — the old
            // unconditional `SolidSolidDifferenceSkipped` short-circuit
            // here meant every CSG primitive cut (issue #780 bath, any
            // `IfcCsgSolid` with a solid cutter) silently rendered as the
            // uncut host even when the operands were trivially small.
            let second_mesh =
                self.process_operand_with_depth(&second_operand, decoder, depth, quality)?;
            if second_mesh.is_empty() {
                self.record_failure(BoolOp::Difference, BoolFailureReason::EmptyOperand);
                return Ok(mesh);
            }
            let clipper = ClippingProcessor::new();
            let result = clipper.subtract_mesh(&mesh, &second_mesh);
            self.drain_clipper_failures(&clipper);
            return result;
        }

        // Handle UNION operation. Under `manifold-csg` this is a real CSG
        // union (overlap removed). Without the feature the legacy path
        // mesh-merges (overlap retained) and records the failure so callers
        // can flag the loss.
        if operator == ".UNION." || operator == "UNION" {
            let second_mesh = self.process_operand_with_depth(&second_operand, decoder, depth, quality)?;
            if second_mesh.is_empty() {
                self.record_failure(BoolOp::Union, BoolFailureReason::EmptyOperand);
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
                    self.process_operand_with_depth(&second_operand, decoder, depth, quality)?;
                if second_mesh.is_empty() {
                    self.record_failure(BoolOp::Intersection, BoolFailureReason::EmptyOperand);
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
            BoolOp::Unknown,
            BoolFailureReason::UnknownBooleanOperator(operator.to_string()),
        );
        Ok(mesh)
    }
}

/// Decide whether `plane` (point + outward normal) is coincident with one
/// of the host mesh's axis-aligned bounding-box faces. The check tolerates
/// numerical noise scaled to the host's diagonal so it works for both
/// metre-scale residential walls and millimetre-scale connector hardware.
fn plane_is_coincident_with_host_face(
    host: &Mesh,
    plane_point: Point3<f64>,
    plane_normal: Vector3<f64>,
) -> bool {
    let (mn, mx) = host.bounds();
    let host_min = Point3::new(mn.x as f64, mn.y as f64, mn.z as f64);
    let host_max = Point3::new(mx.x as f64, mx.y as f64, mx.z as f64);
    let dx = host_max.x - host_min.x;
    let dy = host_max.y - host_min.y;
    let dz = host_max.z - host_min.z;
    let diag = (dx * dx + dy * dy + dz * dz).sqrt();
    if diag <= 0.0 {
        return false;
    }
    // 0.1 % of host diagonal, but never less than 1 mm. A 4 m wall ⇒ 4 mm;
    // a 20 mm fastener ⇒ 1 mm. Tight enough to reject planes that are
    // unambiguously *outside* the host (the "intentional engulf" case)
    // while still catching the Revit top-trim that lands exactly on the
    // wall's top face within float-precision noise.
    let tol = (diag * 0.001).max(0.001);

    // Test all 8 bbox corners against the plane. If ANY corner is within
    // `tol` of the plane, the plane is touching (or near-coincident with)
    // a face. This catches axis-aligned faces (4 corners hit), as well as
    // edges (2 corners hit) and even single-vertex grazes — all of which
    // signal that the cut author meant the plane to ride the host surface,
    // not engulf the body from far away.
    let corners = [
        Point3::new(host_min.x, host_min.y, host_min.z),
        Point3::new(host_max.x, host_min.y, host_min.z),
        Point3::new(host_min.x, host_max.y, host_min.z),
        Point3::new(host_max.x, host_max.y, host_min.z),
        Point3::new(host_min.x, host_min.y, host_max.z),
        Point3::new(host_max.x, host_min.y, host_max.z),
        Point3::new(host_min.x, host_max.y, host_max.z),
        Point3::new(host_max.x, host_max.y, host_max.z),
    ];
    for c in &corners {
        let signed = (c - plane_point).dot(&plane_normal);
        if signed.abs() <= tol {
            return true;
        }
    }
    false
}

impl GeometryProcessor for BooleanClippingProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        self.process_with_depth(entity, decoder, schema, 0, quality)
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
