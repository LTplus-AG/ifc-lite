// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::super::helpers::parse_axis2_placement_3d;
use super::BooleanClippingProcessor;
use crate::{calculate_normals, Error, Mesh, Point2, Point3, Profile2D, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

impl BooleanClippingProcessor {
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

    pub(super) fn build_polygonal_bounded_half_space_mesh(
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
}
