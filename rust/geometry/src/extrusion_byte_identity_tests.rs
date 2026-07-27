// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! B4.4 safety net: the generic-over-scalar extrusion mesher must be
//! **bit-for-bit** the code it replaced when instantiated at `f64`.
//!
//! `reference` below is a verbatim copy of `extrude_profile` and its helpers as
//! they stood before the `GeomScalar` / `MeshSink` refactor (commit 40b4eabb).
//! The tests drive both implementations over a seeded battery of profiles and
//! assert equality of the raw `f32` position/normal bits and the index buffer.
//! If a future edit to the generic mesher changes production output, this fails
//! loudly instead of silently invalidating every geometry golden in the repo.

use super::*;
use crate::profile::Profile2D;

mod reference {
    //! Verbatim pre-refactor implementations. Do not "clean up".
    #![allow(clippy::needless_range_loop)]

    use crate::error::{Error, Result};
    use crate::mesh::Mesh;
    use crate::profile::{Profile2D, Triangulation};
    use nalgebra::{Matrix4, Point2, Point3, Vector3};

    pub fn extrude_profile(
        profile: &Profile2D,
        depth: f64,
        transform: Option<Matrix4<f64>>,
    ) -> Result<Mesh> {
        if depth <= 0.0 {
            return Err(Error::InvalidExtrusion(
                "Depth must be positive".to_string(),
            ));
        }

        let should_skip_caps = profile_has_extreme_aspect_ratio(&profile.outer);

        let triangulation = if should_skip_caps {
            None
        } else {
            Some(triangulate(profile)?)
        };

        let cap_vertex_count = triangulation
            .as_ref()
            .map(|t| t.points.len() * 2)
            .unwrap_or(0);
        let side_vertex_count = profile.outer.len() * 2;
        let total_vertices = cap_vertex_count + side_vertex_count;

        let cap_index_count = triangulation
            .as_ref()
            .map(|t| t.indices.len() * 2)
            .unwrap_or(0);
        let mut mesh =
            Mesh::with_capacity(total_vertices, cap_index_count + profile.outer.len() * 6);

        if let Some(ref tri) = triangulation {
            create_cap_mesh(tri, 0.0, Vector3::new(0.0, 0.0, -1.0), &mut mesh);
            create_cap_mesh(tri, depth, Vector3::new(0.0, 0.0, 1.0), &mut mesh);
        }

        create_side_walls(&profile.outer, depth, &mut mesh);

        for hole in &profile.holes {
            create_side_walls(hole, depth, &mut mesh);
        }

        if let Some(mat) = transform {
            apply_transform(&mut mesh, &mat);
        }

        Ok(mesh)
    }

    fn triangulate(profile: &Profile2D) -> Result<Triangulation> {
        if profile.outer.len() < 3 {
            return Err(Error::InvalidProfile(
                "Profile must have at least 3 vertices".to_string(),
            ));
        }

        let mut vertices = Vec::with_capacity(
            (profile.outer.len() + profile.holes.iter().map(|h| h.len()).sum::<usize>()) * 2,
        );

        for p in &profile.outer {
            vertices.push(p.x);
            vertices.push(p.y);
        }

        let mut hole_indices = Vec::with_capacity(profile.holes.len());
        for hole in &profile.holes {
            hole_indices.push(vertices.len() / 2);
            for p in hole {
                vertices.push(p.x);
                vertices.push(p.y);
            }
        }

        let indices = if hole_indices.is_empty() {
            crate::triangulation::safe_earcut(&vertices, &[], 2)
                .map_err(Error::TriangulationError)?
        } else {
            crate::triangulation::safe_earcut(&vertices, &hole_indices, 2)
                .map_err(Error::TriangulationError)?
        };

        let mut points = Vec::with_capacity(vertices.len() / 2);
        for i in (0..vertices.len()).step_by(2) {
            if i + 1 >= vertices.len() {
                break;
            }
            points.push(Point2::new(vertices[i], vertices[i + 1]));
        }

        Ok(Triangulation { points, indices })
    }

    fn profile_has_extreme_aspect_ratio(outer: &[Point2<f64>]) -> bool {
        if outer.len() < 3 {
            return false;
        }

        let mut min_x = f64::MAX;
        let mut max_x = f64::MIN;
        let mut min_y = f64::MAX;
        let mut max_y = f64::MIN;

        for p in outer {
            min_x = min_x.min(p.x);
            max_x = max_x.max(p.x);
            min_y = min_y.min(p.y);
            max_y = max_y.max(p.y);
        }

        let width = max_x - min_x;
        let height = max_y - min_y;

        if width < 0.001 || height < 0.001 {
            return false;
        }

        let aspect_ratio = (width / height).max(height / width);

        aspect_ratio > 10000.0
    }

    fn create_cap_mesh(
        triangulation: &Triangulation,
        z: f64,
        normal: Vector3<f64>,
        mesh: &mut Mesh,
    ) {
        let base_index = mesh.vertex_count() as u32;

        for point in &triangulation.points {
            mesh.add_vertex(Point3::new(point.x, point.y, z), normal);
        }

        for i in (0..triangulation.indices.len()).step_by(3) {
            if i + 2 >= triangulation.indices.len() {
                break;
            }
            let i0 = base_index + triangulation.indices[i] as u32;
            let i1 = base_index + triangulation.indices[i + 1] as u32;
            let i2 = base_index + triangulation.indices[i + 2] as u32;

            if z == 0.0 {
                mesh.add_triangle(i0, i2, i1);
            } else {
                mesh.add_triangle(i0, i1, i2);
            }
        }
    }

    fn create_side_walls(boundary: &[Point2<f64>], depth: f64, mesh: &mut Mesh) {
        let n = boundary.len();
        if n < 2 {
            return;
        }

        let mut cx = 0.0;
        let mut cy = 0.0;
        for p in boundary.iter() {
            cx += p.x;
            cy += p.y;
        }
        cx /= n as f64;
        cy /= n as f64;

        let use_smooth_radial_normals = is_approximately_circular_profile(boundary, cx, cy);
        let vertex_normals: Vec<Vector3<f64>> = if use_smooth_radial_normals {
            boundary
                .iter()
                .map(|p| {
                    Vector3::new(p.x - cx, p.y - cy, 0.0)
                        .try_normalize(1e-10)
                        .unwrap_or(Vector3::new(0.0, 0.0, 1.0))
                })
                .collect()
        } else {
            Vec::new()
        };

        let signed_area2: f64 = (0..n)
            .map(|i| {
                let a = &boundary[i];
                let b = &boundary[(i + 1) % n];
                a.x * b.y - b.x * a.y
            })
            .sum();
        let winding_sign = if signed_area2 < 0.0 { -1.0 } else { 1.0 };

        let base_index = mesh.vertex_count() as u32;
        let mut quad_count = 0u32;

        for i in 0..n {
            let j = (i + 1) % n;

            let p0 = &boundary[i];
            let p1 = &boundary[j];

            let edge = Vector3::new(p1.x - p0.x, p1.y - p0.y, 0.0);
            if edge.magnitude_squared() < 1e-20 {
                continue;
            }

            let flat_normal = Vector3::new(edge.y, -edge.x, 0.0)
                .try_normalize(1e-10)
                .map(|v| v * winding_sign)
                .unwrap_or(Vector3::new(0.0, 0.0, 1.0));
            let n0 = if use_smooth_radial_normals {
                vertex_normals[i]
            } else {
                flat_normal
            };
            let n1 = if use_smooth_radial_normals {
                vertex_normals[j]
            } else {
                flat_normal
            };

            let v0_bottom = Point3::new(p0.x, p0.y, 0.0);
            let v1_bottom = Point3::new(p1.x, p1.y, 0.0);

            let v0_top = Point3::new(p0.x, p0.y, depth);
            let v1_top = Point3::new(p1.x, p1.y, depth);

            let idx = base_index + (quad_count * 4);
            mesh.add_vertex(v0_bottom, n0);
            mesh.add_vertex(v1_bottom, n1);
            mesh.add_vertex(v1_top, n1);
            mesh.add_vertex(v0_top, n0);

            if winding_sign > 0.0 {
                mesh.add_triangle(idx, idx + 1, idx + 2);
                mesh.add_triangle(idx, idx + 2, idx + 3);
            } else {
                mesh.add_triangle(idx, idx + 2, idx + 1);
                mesh.add_triangle(idx, idx + 3, idx + 2);
            }

            quad_count += 1;
        }
    }

    fn is_approximately_circular_profile(boundary: &[Point2<f64>], cx: f64, cy: f64) -> bool {
        if boundary.len() < 20 {
            return false;
        }

        let mut radii: Vec<f64> = Vec::with_capacity(boundary.len());
        for p in boundary {
            let r = ((p.x - cx).powi(2) + (p.y - cy).powi(2)).sqrt();
            if !r.is_finite() || r < 1e-9 {
                return false;
            }
            radii.push(r);
        }

        let mean = radii.iter().sum::<f64>() / radii.len() as f64;
        if mean < 1e-9 {
            return false;
        }

        let variance = radii
            .iter()
            .map(|r| {
                let d = r - mean;
                d * d
            })
            .sum::<f64>()
            / radii.len() as f64;
        let std_dev = variance.sqrt();
        let coeff_var = std_dev / mean;

        coeff_var < 0.15
    }

    pub fn apply_transform(mesh: &mut Mesh, transform: &Matrix4<f64>) {
        mesh.positions.chunks_exact_mut(3).for_each(|chunk| {
            let point = Point3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
            let transformed = transform.transform_point(&point);
            chunk[0] = transformed.x as f32;
            chunk[1] = transformed.y as f32;
            chunk[2] = transformed.z as f32;
        });

        let normal_matrix = transform.try_inverse().unwrap_or(*transform).transpose();

        mesh.normals.chunks_exact_mut(3).for_each(|chunk| {
            let normal = Vector3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
            let transformed = (normal_matrix * normal.to_homogeneous()).xyz().normalize();
            chunk[0] = transformed.x as f32;
            chunk[1] = transformed.y as f32;
            chunk[2] = transformed.z as f32;
        });
    }

    /// Pre-refactor `ExtrudedAreaSolidProcessor` direction handling.
    pub fn extrusion_local_transform(
        direction: &Vector3<f64>,
        depth: f64,
    ) -> Option<Matrix4<f64>> {
        let local_direction = direction.normalize();
        let is_local_z_aligned =
            local_direction.x.abs() < 0.001 && local_direction.y.abs() < 0.001;
        if is_local_z_aligned {
            if local_direction.z < 0.0 {
                Some(Matrix4::new_translation(&Vector3::new(0.0, 0.0, -depth)))
            } else {
                None
            }
        } else {
            let mut shear_mat = Matrix4::identity();
            shear_mat[(0, 2)] = local_direction.x;
            shear_mat[(1, 2)] = local_direction.y;
            shear_mat[(2, 2)] = local_direction.z;
            Some(shear_mat)
        }
    }
}

/// xorshift64* — seeded, portable, no dev-dependency.
struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed | 1)
    }
    fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + self.unit() * (hi - lo)
    }
}

fn assert_mesh_bit_identical(a: &Mesh, b: &Mesh, what: &str) {
    assert_eq!(a.positions.len(), b.positions.len(), "{what}: position len");
    assert_eq!(a.normals.len(), b.normals.len(), "{what}: normal len");
    assert_eq!(a.indices, b.indices, "{what}: indices");
    for (i, (x, y)) in a.positions.iter().zip(b.positions.iter()).enumerate() {
        assert_eq!(x.to_bits(), y.to_bits(), "{what}: position[{i}] {x} vs {y}");
    }
    for (i, (x, y)) in a.normals.iter().zip(b.normals.iter()).enumerate() {
        assert_eq!(x.to_bits(), y.to_bits(), "{what}: normal[{i}] {x} vs {y}");
    }
}

/// Build a seeded profile that exercises every branch in the mesher:
/// rectangles, near-circles (>= 20 verts, the smooth-radial-normal path),
/// CW and CCW windings, holes, duplicate vertices, extreme aspect ratios.
fn random_profile(rng: &mut Rng, kind: usize) -> Profile2D {
    match kind % 8 {
        // Rectangle (the B4.4 family).
        0 => crate::profile::create_rectangle(rng.range(0.1, 10.0), rng.range(0.1, 10.0)),
        // Reversed (CW) rectangle.
        1 => {
            let mut p = crate::profile::create_rectangle(rng.range(0.1, 10.0), rng.range(0.1, 10.0));
            p.outer.reverse();
            p
        }
        // Random convex-ish n-gon.
        2 => {
            let n = 5 + (rng.next_u64() % 12) as usize;
            let r = rng.range(0.5, 5.0);
            let pts = (0..n)
                .map(|i| {
                    let a = 2.0 * std::f64::consts::PI * i as f64 / n as f64;
                    Point2::new(r * a.cos() + rng.range(-0.2, 0.2), r * a.sin())
                })
                .collect();
            Profile2D::new(pts)
        }
        // Near-circle: >= 20 vertices, low radius variance -> smooth radial normals.
        3 => {
            let n = 24 + (rng.next_u64() % 24) as usize;
            let r = rng.range(0.5, 5.0);
            let pts = (0..n)
                .map(|i| {
                    let a = 2.0 * std::f64::consts::PI * i as f64 / n as f64;
                    let rr = r * (1.0 + rng.range(-0.02, 0.02));
                    Point2::new(rr * a.cos(), rr * a.sin())
                })
                .collect();
            Profile2D::new(pts)
        }
        // Near-circle with just enough variance to fail the 0.15 coeff-var gate.
        4 => {
            let n = 20 + (rng.next_u64() % 10) as usize;
            let r = rng.range(0.5, 5.0);
            let pts = (0..n)
                .map(|i| {
                    let a = 2.0 * std::f64::consts::PI * i as f64 / n as f64;
                    let rr = r * (1.0 + rng.range(-0.4, 0.4));
                    Point2::new(rr * a.cos(), rr * a.sin())
                })
                .collect();
            Profile2D::new(pts)
        }
        // Rectangle with a rectangular hole (CW hole).
        5 => {
            let w = rng.range(2.0, 10.0);
            let h = rng.range(2.0, 10.0);
            let mut p = crate::profile::create_rectangle(w, h);
            let hw = w * rng.range(0.1, 0.3);
            let hh = h * rng.range(0.1, 0.3);
            let cx = rng.range(-w * 0.2, w * 0.2);
            let cy = rng.range(-h * 0.2, h * 0.2);
            p.add_hole(vec![
                Point2::new(cx - hw, cy - hh),
                Point2::new(cx - hw, cy + hh),
                Point2::new(cx + hw, cy + hh),
                Point2::new(cx + hw, cy - hh),
            ]);
            p
        }
        // Extreme aspect ratio -> cap-skipping branch.
        6 => crate::profile::create_rectangle(rng.range(1e-5, 1e-4), rng.range(5.0, 20.0)),
        // Duplicate consecutive vertices -> safe_earcut sanitisation + degenerate
        // side-wall edges.
        _ => {
            let w = rng.range(1.0, 8.0);
            let h = rng.range(1.0, 8.0);
            Profile2D::new(vec![
                Point2::new(-w, -h),
                Point2::new(-w, -h),
                Point2::new(w, -h),
                Point2::new(w, h),
                Point2::new(w, h),
                Point2::new(-w, h),
            ])
        }
    }
}

fn random_transform(rng: &mut Rng) -> Option<Matrix4<f64>> {
    match rng.next_u64() % 3 {
        0 => None,
        1 => {
            let t = Vector3::new(rng.range(-50.0, 50.0), rng.range(-50.0, 50.0), rng.range(-5.0, 5.0));
            Some(Matrix4::new_translation(&t))
        }
        _ => {
            let a = rng.range(-std::f64::consts::PI, std::f64::consts::PI);
            let b = rng.range(-0.7, 0.7);
            let rot = nalgebra::Rotation3::from_euler_angles(b, 0.0, a).to_homogeneous();
            let t = Matrix4::new_translation(&Vector3::new(
                rng.range(-20.0, 20.0),
                rng.range(-20.0, 20.0),
                rng.range(-20.0, 20.0),
            ));
            Some(t * rot)
        }
    }
}

#[test]
fn generic_extrude_is_bit_identical_to_pre_refactor_f64() {
    let mut rng = Rng::new(0xB44_0000_1234);
    let mut checked = 0usize;
    let mut errors = 0usize;
    for k in 0..4000usize {
        let profile = random_profile(&mut rng, k);
        let depth = rng.range(0.05, 30.0);
        let transform = random_transform(&mut rng);

        let got = extrude_profile(&profile, depth, transform);
        let want = reference::extrude_profile(&profile, depth, transform);
        match (got, want) {
            (Ok(a), Ok(b)) => {
                assert_mesh_bit_identical(&a, &b, &format!("case {k}"));
                checked += 1;
            }
            (Err(a), Err(b)) => {
                assert_eq!(a.to_string(), b.to_string(), "case {k}: error text");
                errors += 1;
            }
            (a, b) => panic!("case {k}: ok/err disagreement: {a:?} vs {b:?}"),
        }
    }
    assert!(checked > 3000, "expected mostly successful extrusions, got {checked} ok / {errors} err");
}

#[test]
fn generic_extrude_rejects_nonpositive_depth_like_reference() {
    let profile = crate::profile::create_rectangle(2.0, 3.0);
    for depth in [0.0, -1.0, -1e-12] {
        let got = extrude_profile(&profile, depth, None);
        let want = reference::extrude_profile(&profile, depth, None);
        assert!(got.is_err() && want.is_err());
        assert_eq!(got.unwrap_err().to_string(), want.unwrap_err().to_string());
    }
}

#[test]
fn extrusion_local_transform_is_bit_identical_to_pre_refactor() {
    use crate::processors::extrusion::extrusion_local_transform;
    let mut rng = Rng::new(0xB44_0000_5678);
    for _ in 0..5000 {
        let dir = match rng.next_u64() % 4 {
            0 => Vector3::new(0.0, 0.0, 1.0),
            1 => Vector3::new(0.0, 0.0, -1.0),
            2 => Vector3::new(rng.range(-1.0, 1.0), rng.range(-1.0, 1.0), rng.range(0.1, 1.0)),
            _ => Vector3::new(rng.range(-1e-4, 1e-4), rng.range(-1e-4, 1e-4), rng.range(-1.0, 1.0)),
        };
        if dir.norm_squared() <= f64::EPSILON {
            continue;
        }
        let depth = rng.range(0.01, 50.0);
        let got = extrusion_local_transform(&dir, depth);
        let want = reference::extrusion_local_transform(&dir, depth);
        match (got, want) {
            (None, None) => {}
            (Some(a), Some(b)) => {
                for i in 0..4 {
                    for j in 0..4 {
                        assert_eq!(
                            a[(i, j)].to_bits(),
                            b[(i, j)].to_bits(),
                            "dir {dir:?} depth {depth}: m[{i}][{j}]"
                        );
                    }
                }
            }
            (a, b) => panic!("dir {dir:?}: {a:?} vs {b:?}"),
        }
    }
}
