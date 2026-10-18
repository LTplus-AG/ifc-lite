// SPDX-License-Identifier: MPL-2.0
//! Owned Position and sampled boundary before host-dependent prism evaluation.
use crate::{Mesh, Point2, Point3, Result, Vector3};
use nalgebra::Matrix4;
#[path = "bounded_prism_mesh.rs"]
mod mesh;

#[derive(Debug, Clone)]
pub(crate) struct BoundedPrismPlan {
    pub(super) transform: Matrix4<f64>,
    pub(super) contour_2d: Vec<Point2<f64>>,
}

impl BoundedPrismPlan {
    /// Host and plane are in the same raw file-unit frame as this source.
    /// The finite depth is derived from this host, never a fixed huge cutter.
    pub(crate) fn evaluate(self, host_mesh: &Mesh,
        (plane_point, plane_normal, agreement): (Point3<f64>, Vector3<f64>, bool),
    ) -> Result<Mesh> {
        let Self { transform, contour_2d } = self;
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
        // covers the wall's full thickness. Extrusion stays on Position.Z.
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
        if polygon_normal(&base).dot(&ext_dir) < 0.0 {
            base.reverse();
            top.reverse();
            contour_2d.reverse();
        }

        mesh::build_tilted_prism_mesh(&contour_2d, &base, &top)
    }
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

#[cfg(test)]
#[path = "bounded_prism_plan_tests.rs"]
mod tests;
