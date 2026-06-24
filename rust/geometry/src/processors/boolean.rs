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
        let mut clipped = processor.clip_mesh(mesh, &plane)?;
        // The plane clip removes the half-space but leaves the cut cross-section
        // OPEN (the BSP kernel's polygon cap was deleted with the BSP port in
        // #1024). Re-close it: a watertight host clipped by a plane leaves an
        // open boundary lying on that plane, forming the section to cap.
        cap_half_space_clip(&mut clipped, plane_point, clip_normal);
        Ok(clipped)
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

        // Earcut NORMALISES its output winding (its linked list re-orients the
        // ring to a fixed orientation), while the side walls below — and the
        // caller's world-normal correction — follow the RAW `contour_2d`
        // order. For a CLOCKWISE contour the caps therefore come out wound
        // against the side walls: BOTH end caps of the prism face INWARD and
        // the boolean sees an open, self-inconsistent cutter (advanced_model
        // PBHS #553001: the 300 mm slot clip leaked +0.018 m³ and left an
        // unpaired quad). Detect the mismatch by comparing the contour's
        // shoelace sign with the orientation of the first non-degenerate
        // output triangle, and flip cap emission so caps and side walls
        // always agree.
        let n = contour_2d.len();
        let shoelace2: f64 = (0..n)
            .map(|i| {
                let p = &contour_2d[i];
                let q = &contour_2d[(i + 1) % n];
                p.x * q.y - q.x * p.y
            })
            .sum();
        let mut flip_caps = false;
        for indices in triangulation.indices.chunks_exact(3) {
            let p0 = &triangulation.points[indices[0]];
            let p1 = &triangulation.points[indices[1]];
            let p2 = &triangulation.points[indices[2]];
            let cross = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
            if cross != 0.0 {
                flip_caps = (cross > 0.0) != (shoelace2 > 0.0);
                break;
            }
        }

        for indices in triangulation.indices.chunks_exact(3) {
            let (i0, i1, i2) = if flip_caps {
                (
                    tri_to_contour[indices[2]],
                    tri_to_contour[indices[1]],
                    tri_to_contour[indices[0]],
                )
            } else {
                (
                    tri_to_contour[indices[0]],
                    tri_to_contour[indices[1]],
                    tri_to_contour[indices[2]],
                )
            };

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
    /// Relies on a *watertight* CSG union of the cutter prisms (built by
    /// [`Self::build_cutter_union`]). No longer manifold-gated — the chain walk
    /// and cutter build are kernel-agnostic and must compile into the pure-Rust
    /// wasm — but it still DEFERS (returns `Ok(None)`) when no available kernel
    /// can produce that watertight union, so a non-manifold mesh-merge is never
    /// fed into the subtract.
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

        // Every cutter is a clean partial cut: union them into ONE watertight
        // solid (a true CSG union, so abutting roof segments share no internal
        // seam) and subtract once. This eliminates both the zero-thickness seam
        // fins that sequential subtraction leaves behind AND the deep-chain
        // MAX_BOOLEAN_DEPTH drops. `build_cutter_union` returns `None` when no
        // available kernel can union the prisms into a watertight solid; we
        // defer (like every other guard here) rather than feed a broken,
        // non-manifold union into the subtract — which the CSG kernel can't
        // classify, silently returning the host UNCHANGED (issue #960 wall
        // #2152: the gable-end wall rendered at full 7000 mm extrusion height).
        let combined = match self.build_cutter_union(&clipper, &prisms) {
            Some(m) if !m.is_empty() => m,
            _ => {
                // Unlike the trial-subtract probes above (whose failures the
                // sequential path re-encounters and re-logs), the union
                // attempt is unique to this path — preserve its kernel
                // failures and record the deferral, since the sequential
                // fallback can leave seam fins the batched subtract avoids.
                self.drain_clipper_failures(&clipper);
                self.record_failure(BoolOp::Union, BoolFailureReason::CutterUnionUnavailable);
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

    /// Union the chained-clip cutter prisms into ONE watertight solid.
    ///
    /// The segmented-roof cutters are prisms that ABUT along shared, exactly-
    /// coplanar faces (adjacent roof facets meeting at a hip/ridge/valley).
    /// Unioning them into a single watertight cutter is what lets the chain be
    /// subtracted ONCE (no seam fins, no deep-chain depth drops — issue #960).
    ///
    /// Returns `None` when no available kernel can produce a watertight union;
    /// the caller then defers to the sequential per-cutter path. We never feed a
    /// non-manifold mesh-merge into the subtract: the CSG kernel cannot classify
    /// a non-watertight cutter and silently returns the host UNCHANGED, leaving
    /// the gable-end wall at full extrusion height.
    fn build_cutter_union(&self, clipper: &ClippingProcessor, prisms: &[Mesh]) -> Option<Mesh> {
        if prisms.is_empty() {
            return None;
        }
        if prisms.len() == 1 {
            return Some(prisms[0].clone());
        }

        // Primary path: the pure-Rust kernel's N-ary union — ONE conforming
        // arrangement of all cutter prisms over a shared interner, so coplanar
        // seams shared by 3+ roof segments (and exactly-duplicated cutter prisms)
        // dissolve without the tearing that left-deep pairwise accumulation
        // produces. This makes the segmented-roof clip (#960) watertight on EVERY
        // build. Exact + platform-deterministic.
        {
            let refs: Vec<&Mesh> = prisms.iter().collect();
            let u = ClippingProcessor::consolidate_coplanar(
                crate::kernel::mesh_bridge::union_many(&refs),
            );
            if !u.is_empty() {
                return Some(u);
            }
        }

        // Fallback: the kernel's sequential multi-mesh union. Returns
        // `None` on empty/error so the caller defers to the per-cutter path.
        match clipper.union_meshes(prisms) {
            Ok(m) if !m.is_empty() => Some(m),
            _ => None,
        }
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
        // The *correctness* of the single subtract hinges on a WATERTIGHT union
        // of the cutter prisms, which `build_cutter_union` computes with the
        // exact kernel's N-ary `union_many`. When it can't produce a watertight
        // union, `try_union_polygonal_chain` returns `None` and we fall through
        // to the sequential path — so this is never worse than pre-#960 (the
        // seam-sliver / deep-chain drop only fully resolves once that union is
        // watertight; 841_house_stack_overflow.ifc).
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
        // We can't do OCCT-style topological CSG in our mesh-CSG
        // kernel, so we follow web-ifc: SEQUENTIAL through the
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
                        // 12-tri box → 2-tri quad on the deleted legacy BSP
                        // kernel). When the result looks degenerate
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

            // Solid-solid difference on the exact kernel (no operand-size
            // cap). The old unconditional `SolidSolidDifferenceSkipped`
            // short-circuit here meant every CSG primitive cut (issue #780
            // bath, any `IfcCsgSolid` with a solid cutter) silently rendered
            // as the uncut host even when the operands were trivially small.
            let second_mesh =
                self.process_operand_with_depth(&second_operand, decoder, depth, quality)?;
            if second_mesh.is_empty() {
                self.record_failure(BoolOp::Difference, BoolFailureReason::EmptyOperand);
                return Ok(mesh);
            }
            // Preview-mode (Lowest/Low) small-cut skip: a cutter far smaller than
            // its host (a steel cope/notch, a small detail recess) costs a full
            // exact subtract — the dominant load-time cost on boolean-heavy steel —
            // for a barely-visible change. In the preview tiers we drop it and
            // render the host un-cut, recovering Manifold-class load times.
            // Medium/High/Highest keep EVERY cut (byte-identical to before).
            if quality_skips_small_cuts(quality) && cutter_below_skip_ratio(&mesh, &second_mesh) {
                return Ok(mesh);
            }
            let clipper = ClippingProcessor::new();
            let result = clipper.subtract_mesh(&mesh, &second_mesh);
            self.drain_clipper_failures(&clipper);
            return result;
        }

        // Handle UNION operation — a real CSG union (overlap removed) on the
        // pure-Rust exact kernel.
        if operator == ".UNION." || operator == "UNION" {
            let second_mesh = self.process_operand_with_depth(&second_operand, decoder, depth, quality)?;
            if second_mesh.is_empty() {
                self.record_failure(BoolOp::Union, BoolFailureReason::EmptyOperand);
                return Ok(mesh);
            }
            let clipper = ClippingProcessor::new();
            let result = clipper.union_mesh(&mesh, &second_mesh);
            self.drain_clipper_failures(&clipper);
            return result;
        }

        // Handle INTERSECTION operation — a real intersection volume on the
        // pure-Rust exact kernel.
        if operator == ".INTERSECTION." || operator == "INTERSECTION" {
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

        self.record_failure(
            BoolOp::Unknown,
            BoolFailureReason::UnknownBooleanOperator(operator.to_string()),
        );
        Ok(mesh)
    }
}

/// Whether this tessellation tier drops sub-threshold boolean cuts (preview
/// tiers only). `Medium` (the default) and finer keep every cut, so their
/// geometry is byte-identical to before this optimization.
fn quality_skips_small_cuts(quality: TessellationQuality) -> bool {
    matches!(quality, TessellationQuality::Lowest | TessellationQuality::Low)
}

/// Skip ratio for preview-mode small-cut dropping: cutter max-dimension as a
/// fraction of host max-dimension. Default 0.10 (≈ Manifold-era load times on
/// the steel corpus with no visible change to members). Native callers can tune
/// it via `IFC_LITE_FAST_CUT_RATIO`; in wasm (no env) the default applies.
fn fast_cut_skip_ratio() -> f64 {
    use std::sync::OnceLock;
    static R: OnceLock<f64> = OnceLock::new();
    *R.get_or_init(|| {
        std::env::var("IFC_LITE_FAST_CUT_RATIO")
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.10)
    })
}

/// True when `cutter`'s largest bounding-box dimension is below
/// [`fast_cut_skip_ratio`] of `host`'s — i.e. a small local cut worth skipping in
/// the preview tiers. Degenerate (zero-extent) hosts never skip.
fn cutter_below_skip_ratio(host: &Mesh, cutter: &Mesh) -> bool {
    let max_dim = |m: &Mesh| -> f64 {
        let (mn, mx) = m.bounds();
        (((mx.x - mn.x) as f64).max((mx.y - mn.y) as f64)).max((mx.z - mn.z) as f64)
    };
    let h = max_dim(host);
    if h <= 0.0 {
        return false;
    }
    max_dim(cutter) / h < fast_cut_skip_ratio()
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

/// Close the planar cut left by an unbounded `IfcHalfSpaceSolid` DIFFERENCE.
///
/// `ClippingProcessor::clip_mesh` clips each triangle to the half-plane but
/// emits nothing for the cut cross-section — before #1024 the in-tree BSP
/// kernel's polygon cap closed it; deleting BSP left this path uncapped, so
/// gable roof-trims, mono-pitch eaves and Revit top-trim walls render as open,
/// inverted shells (negative signed volume, dozens of open edges).
///
/// A watertight host clipped by a plane has exactly one open boundary — the
/// section, lying on the cut plane. We weld coincident vertices (the clipper
/// emits bit-identical coordinates for shared cut points, so an exact f32-bit
/// key merges them without a tolerance grid that could fuse distinct corners),
/// chain the on-plane boundary half-edges into loops, classify them into
/// outer rings and holes by even-odd nesting, triangulate each region with the
/// kernel's CDT, and append the result wound to face `-clip_normal` (away from
/// the kept `+clip_normal` material). If the boundary is non-manifold or does
/// not close (a non-watertight host), we bail and leave the mesh unchanged —
/// never worse than the uncapped output.
pub(crate) fn cap_half_space_clip(mesh: &mut Mesh, plane_point: Point3<f64>, clip_normal: Vector3<f64>) {
    use crate::triangulation::{project_to_2d, triangulate_polygon_with_holes_refined};
    use std::collections::{HashMap, HashSet};

    // Escape hatch: revert to the pre-fix (uncapped) plane clip without a
    // rebuild, should the section cap ever misbehave on an unforeseen host.
    if std::env::var_os("IFC_LITE_HALFSPACE_CAP_OFF").is_some() {
        return;
    }
    let tri_n = mesh.indices.len() / 3;
    let vcount = mesh.positions.len() / 3;
    if tri_n == 0 || vcount < 3 {
        return;
    }
    let n = match clip_normal.try_normalize(1e-12) {
        Some(v) => v,
        None => return,
    };

    // Diagonal-relative tolerance for "lies on the cut plane".
    let (mn, mx) = mesh.bounds();
    let diag =
        ((mx.x - mn.x).powi(2) + (mx.y - mn.y).powi(2) + (mx.z - mn.z).powi(2)).sqrt() as f64;
    let on_plane_eps = (diag * 1.0e-5).max(1.0e-6);

    // Weld coincident vertices on a spatial grid tied to the on-plane tolerance,
    // NOT exact f32 bits. Exact-bit welding is too strict for the layer path: the
    // innermost slab is built by TWO successive plane clips (after_prev, then the
    // FLIPPED before_next), and each clip regenerates the section vertices via
    // independent f32 edge interpolation. On a non-convex IfcArbitraryClosedProfileDef
    // the two passes deposit geometrically-coincident cut points that differ by
    // ~1 ULP — both flagged on-plane yet left UNWELDED by an exact-bits key. That
    // 1-ULP gap breaks the boundary chain: a sub-loop dead-ends and is dropped,
    // leaving open edges (a non-watertight slab → "see inside" / no 2D fill).
    // Quantising to weld_eps (= on_plane_eps, orders of magnitude finer than any
    // real wall feature) snaps the ULP-twins into one bucket so the loop closes.
    // Single-plane callers (opening cuts) have no such twins, so genuinely
    // distinct corners stay in distinct buckets.
    let weld_eps = on_plane_eps;
    let quant = |c: f32| -> i64 { (c as f64 / weld_eps).round() as i64 };
    let mut weld: HashMap<(i64, i64, i64), u32> = HashMap::new();
    let mut pos: Vec<Point3<f64>> = Vec::new();
    let mut on_plane: Vec<bool> = Vec::new();
    let mut welded: Vec<u32> = Vec::with_capacity(vcount);
    for i in 0..vcount {
        let key = (
            quant(mesh.positions[i * 3]),
            quant(mesh.positions[i * 3 + 1]),
            quant(mesh.positions[i * 3 + 2]),
        );
        let id = match weld.get(&key) {
            Some(&id) => id,
            None => {
                let p = Point3::new(
                    mesh.positions[i * 3] as f64,
                    mesh.positions[i * 3 + 1] as f64,
                    mesh.positions[i * 3 + 2] as f64,
                );
                let id = pos.len() as u32;
                on_plane.push((p - plane_point).dot(&n).abs() <= on_plane_eps);
                pos.push(p);
                weld.insert(key, id);
                id
            }
        };
        welded.push(id);
    }

    // Directed half-edges; an undirected edge with no twin is on the open
    // boundary. Restrict to edges whose endpoints both lie on the cut plane so
    // a pre-existing open boundary (non-watertight host) is never re-capped.
    let mut present: HashSet<(u32, u32)> = HashSet::new();
    for t in 0..tri_n {
        let v = [
            welded[mesh.indices[t * 3] as usize],
            welded[mesh.indices[t * 3 + 1] as usize],
            welded[mesh.indices[t * 3 + 2] as usize],
        ];
        for (a, b) in [(v[0], v[1]), (v[1], v[2]), (v[2], v[0])] {
            if a != b {
                present.insert((a, b));
            }
        }
    }
    let mut next: HashMap<u32, u32> = HashMap::new();
    for &(a, b) in &present {
        if present.contains(&(b, a)) {
            continue; // interior edge
        }
        if !on_plane[a as usize] || !on_plane[b as usize] {
            continue; // not the cut section
        }
        if next.insert(a, b).is_some() {
            return; // non-manifold cut boundary → bail
        }
    }
    if next.is_empty() {
        return;
    }

    // Chain the boundary half-edges into closed loops.
    let mut starts: Vec<u32> = next.keys().copied().collect();
    starts.sort_unstable();
    let mut visited: HashSet<u32> = HashSet::new();
    let mut loops: Vec<Vec<u32>> = Vec::new();
    for &s in &starts {
        if visited.contains(&s) {
            continue;
        }
        let mut loop_v: Vec<u32> = Vec::new();
        let mut cur = s;
        loop {
            if !visited.insert(cur) {
                break;
            }
            loop_v.push(cur);
            match next.get(&cur) {
                Some(&nx) => cur = nx,
                None => {
                    loop_v.clear();
                    break;
                }
            }
            if cur == s {
                break;
            }
        }
        if loop_v.len() >= 3 {
            loops.push(loop_v);
        }
    }
    if loops.is_empty() {
        return;
    }

    // Project every loop into one shared 2D basis whose +w faces the cap's
    // outward normal (-clip_normal), so a CCW triangulated ring lifts to a
    // triangle whose geometric normal already points outward.
    let cap_outward = -n;
    let mut all3d: Vec<Point3<f64>> = Vec::new();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for lp in &loops {
        let start = all3d.len();
        for &i in lp {
            all3d.push(pos[i as usize]);
        }
        ranges.push((start, all3d.len()));
    }
    let (all2d, u_axis, v_axis, origin) = project_to_2d(&all3d, &cap_outward);

    let signed_area = |ring: &[Point2<f64>]| -> f64 {
        let mut s = 0.0;
        let m = ring.len();
        for i in 0..m {
            let j = (i + 1) % m;
            s += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
        }
        s * 0.5
    };
    let point_in_ring = |pt: &Point2<f64>, ring: &[Point2<f64>]| -> bool {
        let mut inside = false;
        let m = ring.len();
        let mut j = m - 1;
        for i in 0..m {
            let (pi, pj) = (ring[i], ring[j]);
            if ((pi.y > pt.y) != (pj.y > pt.y))
                && (pt.x < (pj.x - pi.x) * (pt.y - pi.y) / (pj.y - pi.y) + pi.x)
            {
                inside = !inside;
            }
            j = i;
        }
        inside
    };

    let rings: Vec<Vec<Point2<f64>>> = ranges
        .iter()
        .map(|&(a, b)| all2d[a..b].to_vec())
        .collect();

    // Even-odd nesting depth: a ring inside an odd number of others is a hole.
    let depth: Vec<usize> = (0..rings.len())
        .map(|i| {
            let probe = rings[i][0];
            (0..rings.len())
                .filter(|&j| j != i && point_in_ring(&probe, &rings[j]))
                .count()
        })
        .collect();

    let cap_normal = [cap_outward.x as f32, cap_outward.y as f32, cap_outward.z as f32];
    let lift = |p: &Point2<f64>| -> Point3<f64> { origin + u_axis * p.x + v_axis * p.y };

    for (oi, ring) in rings.iter().enumerate() {
        if !depth[oi].is_multiple_of(2) {
            continue; // hole — emitted with its outer ring
        }
        // Outer ring CCW; its immediate holes (depth+1, contained) CW.
        let mut outer = ring.clone();
        if signed_area(&outer) < 0.0 {
            outer.reverse();
        }
        let mut holes: Vec<Vec<Point2<f64>>> = Vec::new();
        for (hi, hring) in rings.iter().enumerate() {
            if hi == oi || depth[hi] != depth[oi] + 1 {
                continue;
            }
            if !point_in_ring(&hring[0], ring) {
                continue;
            }
            let mut h = hring.clone();
            if signed_area(&h) > 0.0 {
                h.reverse();
            }
            holes.push(h);
        }

        let (verts2d, indices) =
            match triangulate_polygon_with_holes_refined(&outer, &holes, false) {
                Ok(r) => r,
                Err(_) => continue,
            };
        let verts3d: Vec<Point3<f64>> = verts2d.iter().map(lift).collect();
        let base = (mesh.positions.len() / 3) as u32;
        for p in &verts3d {
            mesh.positions
                .extend_from_slice(&[p.x as f32, p.y as f32, p.z as f32]);
            mesh.normals.extend_from_slice(&cap_normal);
        }
        for tri in indices.chunks_exact(3) {
            let (a, b, c) = (verts3d[tri[0]], verts3d[tri[1]], verts3d[tri[2]]);
            // Wind to face the cap outward normal regardless of CDT convention.
            let geo_n = (b - a).cross(&(c - a));
            let (i1, i2) = if geo_n.dot(&cap_outward) >= 0.0 {
                (tri[1], tri[2])
            } else {
                (tri[2], tri[1])
            };
            mesh.indices
                .extend_from_slice(&[base + tri[0] as u32, base + i1 as u32, base + i2 as u32]);
        }
    }
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

#[cfg(test)]
mod halfspace_cap_tests {
    use super::*;
    use crate::csg::{ClippingProcessor, Plane};

    /// Outward-wound watertight unit cube, one face per quad → two triangles,
    /// vertices duplicated per triangle (as the clipper itself emits them).
    fn unit_box() -> Mesh {
        let c = [
            [0.0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0],
        ];
        let tris: [[usize; 3]; 12] = [
            [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
            [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
            [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
        ];
        let mut m = Mesh::new();
        for t in tris {
            let base = (m.positions.len() / 3) as u32;
            for &vi in &t {
                m.positions.extend_from_slice(&c[vi]);
                m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
            m.indices.extend_from_slice(&[base, base + 1, base + 2]);
        }
        m
    }

    /// Open boundary edges, vertices welded on a 10 µm grid.
    fn open_edges(m: &Mesh) -> usize {
        use std::collections::HashMap;
        let key = |i: usize| -> (i64, i64, i64) {
            (
                (m.positions[i * 3] as f64 * 1.0e5).round() as i64,
                (m.positions[i * 3 + 1] as f64 * 1.0e5).round() as i64,
                (m.positions[i * 3 + 2] as f64 * 1.0e5).round() as i64,
            )
        };
        let mut vid: HashMap<(i64, i64, i64), u32> = HashMap::new();
        let mut bal: HashMap<(u32, u32), i32> = HashMap::new();
        for tri in m.indices.chunks_exact(3) {
            let mut id = [0u32; 3];
            for (j, &vi) in tri.iter().enumerate() {
                let k = key(vi as usize);
                let n = vid.len() as u32;
                id[j] = *vid.entry(k).or_insert(n);
            }
            for (x, y) in [(id[0], id[1]), (id[1], id[2]), (id[2], id[0])] {
                let (kk, s) = if x < y { ((x, y), 1) } else { ((y, x), -1) };
                *bal.entry(kk).or_insert(0) += s;
            }
        }
        bal.values().filter(|&&v| v != 0).count()
    }

    fn signed_volume(m: &Mesh) -> f64 {
        let p = |i: usize| {
            [
                m.positions[i * 3] as f64,
                m.positions[i * 3 + 1] as f64,
                m.positions[i * 3 + 2] as f64,
            ]
        };
        let mut vol = 0.0;
        for tri in m.indices.chunks_exact(3) {
            let (a, b, c) = (p(tri[0] as usize), p(tri[1] as usize), p(tri[2] as usize));
            vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.0;
        }
        vol
    }

    /// Extrude a CCW 2D profile (XY) along Z into a watertight, outward-wound
    /// prism: side quads + earcut top/bottom caps, vertices duplicated per
    /// triangle (as the clipper emits them). Lets a test build a NON-CONVEX host
    /// whose thickness-slice section is itself non-convex/disjoint.
    fn extrude_profile(profile: &[[f32; 2]], z0: f32, z1: f32) -> Mesh {
        use crate::triangulation::triangulate_polygon;
        use nalgebra::Point2;
        let mut m = Mesh::new();
        let mut push = |a: [f32; 3], b: [f32; 3], c: [f32; 3]| {
            let base = (m.positions.len() / 3) as u32;
            for v in [a, b, c] {
                m.positions.extend_from_slice(&v);
                m.normals.extend_from_slice(&[0.0, 0.0, 0.0]);
            }
            m.indices.extend_from_slice(&[base, base + 1, base + 2]);
        };
        let n = profile.len();
        for i in 0..n {
            let a = profile[i];
            let b = profile[(i + 1) % n];
            let (a0, b0) = ([a[0], a[1], z0], [b[0], b[1], z0]);
            let (b1, a1) = ([b[0], b[1], z1], [a[0], a[1], z1]);
            push(a0, b0, b1); // outward (CCW profile ⇒ interior on the left)
            push(a0, b1, a1);
        }
        let pts: Vec<Point2<f64>> = profile
            .iter()
            .map(|p| Point2::new(p[0] as f64, p[1] as f64))
            .collect();
        let idx = triangulate_polygon(&pts).expect("earcut profile");
        for t in idx.chunks_exact(3) {
            let (a, b, c) = (profile[t[0]], profile[t[1]], profile[t[2]]);
            // top cap (+Z, CCW), bottom cap (−Z, reversed) → outward both.
            push([a[0], a[1], z1], [b[0], b[1], z1], [c[0], c[1], z1]);
            push([a[0], a[1], z0], [c[0], c[1], z0], [b[0], b[1], z0]);
        }
        m
    }

    /// General guard for the material-layer cap on irregular hosts: an inner
    /// slab built by the SAME two-pass clip the layer slicer runs (after_prev,
    /// then the FLIPPED before_next) must come out watertight even when the cut
    /// section is non-convex. The host is a U-profile prism, so a thickness (Y)
    /// slice through the arms is two disjoint columns — a genuinely non-convex,
    /// multi-loop cut section the cap has to triangulate. (The specific ULP-twin
    /// weld regression is pinned by `cap_welds_ulp_twin_section_corner` below.)
    #[test]
    fn two_pass_layer_clip_on_nonconvex_profile_is_watertight() {
        // U opening +Y: arms at x∈[0,1] and x∈[2,3] for y∈[1,3], joined y∈[0,1].
        let u = [
            [0.0f32, 0.0], [3.0, 0.0], [3.0, 3.0], [2.0, 3.0],
            [2.0, 1.0], [1.0, 1.0], [1.0, 3.0], [0.0, 3.0],
        ];
        let host = extrude_profile(&u, 0.0, 2.5);
        assert_eq!(open_edges(&host), 0, "fixture U-prism must be watertight");

        // A thin inner slab in the arms band y∈[1.6,2.4] (section = two columns).
        let clipper = ClippingProcessor::new();
        let after_prev = Plane::new(Point3::new(0.0, 1.6, 0.0), Vector3::new(0.0, 1.0, 0.0));
        let before_next = Plane::new(Point3::new(0.0, 2.4, 0.0), Vector3::new(0.0, 1.0, 0.0));

        let mut slab = clipper.clip_mesh(&host, &after_prev).unwrap();
        cap_half_space_clip(&mut slab, after_prev.point, after_prev.normal);
        let flipped = Plane::new(before_next.point, -before_next.normal);
        let mut slab = clipper.clip_mesh(&slab, &flipped).unwrap();
        cap_half_space_clip(&mut slab, flipped.point, flipped.normal);

        assert_eq!(
            open_edges(&slab), 0,
            "two-pass-clipped non-convex inner slab must be watertight after capping"
        );
        // Two columns, each 1×0.8×2.5 ⇒ |V| = 4.0; positive ⇒ outward winding.
        let v = signed_volume(&slab);
        assert!(v > 0.0, "slab winding must stay outward (got {v})");
        assert!((v - 4.0).abs() < 1.0e-3, "slab volume should be ~4.0, got {v}");
    }

    /// Precise regression for the weld fix: a cut section whose boundary loop has
    /// ONE corner stored as two ~1-ULP-apart f32 values (geometrically the same
    /// point, as the two-pass layer clip produces on irregular profiles). With
    /// exact-bit welding those twins stay separate, the boundary chain dead-ends
    /// at that corner, the cap drops the whole loop and the section stays open
    /// (the observed open edges). The spatial-grid weld collapses the twins so
    /// the loop closes. Fixture: a unit box with its z=0 cap removed (open
    /// section) and the right wall's shared bottom corner nudged 1 ULP in x.
    #[test]
    fn cap_welds_ulp_twin_section_corner() {
        let one_ulp = f32::from_bits(1.0f32.to_bits() + 1); // next f32 after 1.0
        let c = [
            [0.0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0],
        ];
        let c1_twin = [one_ulp, 0.0, 0.0]; // coincident with c[1] but 1 ULP off
        let mut m = Mesh::new();
        let mut push = |a: [f32; 3], b: [f32; 3], cc: [f32; 3]| {
            let base = (m.positions.len() / 3) as u32;
            for v in [a, b, cc] {
                m.positions.extend_from_slice(&v);
                m.normals.extend_from_slice(&[0.0, 0.0, 0.0]);
            }
            m.indices.extend_from_slice(&[base, base + 1, base + 2]);
        };
        // unit box MINUS its z=0 cap; right wall uses c1_twin for the shared
        // bottom-front corner so the z=0 loop has the coincident twin.
        push(c[4], c[5], c[6]); push(c[4], c[6], c[7]); // top   (z=1)
        push(c[0], c[1], c[5]); push(c[0], c[5], c[4]); // front (y=0) — c[1]
        push(c1_twin, c[2], c[6]); push(c1_twin, c[6], c[5]); // right (x=1) — twin
        push(c[2], c[3], c[7]); push(c[2], c[7], c[6]); // back  (y=1)
        push(c[3], c[0], c[4]); push(c[3], c[4], c[7]); // left  (x=0)

        assert!(open_edges(&m) > 0, "fixture is open at z=0 before capping");
        cap_half_space_clip(&mut m, Point3::new(0.5, 0.5, 0.0), Vector3::new(0.0, 0.0, 1.0));
        assert_eq!(
            open_edges(&m), 0,
            "cap must weld the ~1-ULP section twin and close the z=0 face"
        );
    }

    /// Regression for the #1024 BSP-cap deletion: an unbounded `IfcHalfSpaceSolid`
    /// DIFFERENCE (the plane clip) must leave a watertight, correctly-wound solid,
    /// not the open inverted shell the uncapped clip produced (AC20 gable walls).
    #[test]
    fn unbounded_half_space_clip_is_capped_and_watertight() {
        let bx = unit_box();
        assert_eq!(open_edges(&bx), 0, "fixture box must be watertight");
        assert!((signed_volume(&bx) - 1.0).abs() < 1.0e-6);

        // Keep the +z half — exactly what clip_mesh_with_half_space does.
        let clip_normal = Vector3::new(0.0, 0.0, 1.0);
        let plane_point = Point3::new(0.5, 0.5, 0.5);
        let clipper = ClippingProcessor::new();
        let mut clipped = clipper
            .clip_mesh(&bx, &Plane::new(plane_point, clip_normal))
            .unwrap();

        // Pre-fix: the cut cross-section is left open.
        assert!(open_edges(&clipped) > 0, "raw plane clip leaves the section open");
        let tris_before = clipped.indices.len() / 3;

        cap_half_space_clip(&mut clipped, plane_point, clip_normal);

        assert_eq!(open_edges(&clipped), 0, "capped clip must be watertight");
        assert!(clipped.indices.len() / 3 > tris_before, "cap must add triangles");
        // Closed kept-half of the unit box → +0.5 (positive ⇒ outward winding).
        let v = signed_volume(&clipped);
        assert!((v - 0.5).abs() < 1.0e-5, "capped half-box volume should be +0.5, got {v}");
    }
}
