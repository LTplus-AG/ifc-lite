// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! CSG primitive processors.
//!
//! Handles `IfcCsgSolid` (the solid-model wrapper around a CSG tree) and the
//! `IfcCsgPrimitive3D` subtypes that can sit at the leaves of that tree.
//! `IfcBlock` and `IfcSphere` are supported as standalone leaves; the rest
//! (`IfcRectangularPyramid`, `IfcRightCircularCone`, `IfcRightCircularCylinder`)
//! are not yet implemented.

use crate::extrusion::apply_transform;
use crate::{Error, Mesh, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Point3;

use super::boolean::BooleanClippingProcessor;
use super::helpers::parse_axis2_placement_3d;
use crate::router::GeometryProcessor;

/// `IfcBlock` — axis-aligned box CSG primitive.
///
/// Attributes (inherits `IfcCsgPrimitive3D` → Position):
///   0: Position (`IfcAxis2Placement3D`)
///   1: XLength
///   2: YLength
///   3: ZLength
///
/// The block occupies `(0,0,0) .. (XLength, YLength, ZLength)` in the local
/// placement frame, then is transformed by Position into the enclosing CSG
/// tree's coordinate system.
pub struct BlockProcessor;

impl BlockProcessor {
    pub fn new() -> Self {
        Self
    }
}

impl Default for BlockProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryProcessor for BlockProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
    ) -> Result<Mesh> {
        let x = entity
            .get_float(1)
            .ok_or_else(|| Error::geometry("IfcBlock missing XLength".to_string()))?;
        let y = entity
            .get_float(2)
            .ok_or_else(|| Error::geometry("IfcBlock missing YLength".to_string()))?;
        let z = entity
            .get_float(3)
            .ok_or_else(|| Error::geometry("IfcBlock missing ZLength".to_string()))?;

        if !(x.is_finite() && y.is_finite() && z.is_finite() && x > 0.0 && y > 0.0 && z > 0.0) {
            return Err(Error::geometry(format!(
                "IfcBlock requires finite positive lengths, got ({}, {}, {})",
                x, y, z
            )));
        }

        let mut mesh = build_axis_aligned_box(x, y, z);

        if let Some(pos_attr) = entity.get(0) {
            if !pos_attr.is_null() {
                if let Some(pos_entity) = decoder.resolve_ref(pos_attr)? {
                    if pos_entity.ifc_type == IfcType::IfcAxis2Placement3D {
                        let transform = parse_axis2_placement_3d(&pos_entity, decoder)?;
                        apply_transform(&mut mesh, &transform);
                    }
                }
            }
        }

        Ok(mesh)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcBlock]
    }
}

/// `IfcCsgSolid` — wraps a CSG tree (`TreeRootExpression`, an `IfcCsgSelect`).
///
/// Attribute 0 (`TreeRootExpression`) is either an `IfcBooleanResult` /
/// `IfcBooleanClippingResult` or an `IfcCsgPrimitive3D`. This processor
/// resolves the reference and dispatches it to the matching leaf processor,
/// so callers don't need to know that the geometry was wrapped.
pub struct CsgSolidProcessor;

impl CsgSolidProcessor {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CsgSolidProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryProcessor for CsgSolidProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
    ) -> Result<Mesh> {
        let root_attr = entity.get(0).ok_or_else(|| {
            Error::geometry("IfcCsgSolid missing TreeRootExpression".to_string())
        })?;
        let root = decoder.resolve_ref(root_attr)?.ok_or_else(|| {
            Error::geometry("IfcCsgSolid TreeRootExpression unresolved".to_string())
        })?;

        // Per IFC 4.3 (`TreeRootExpression : IfcCsgSelect`), the root must be
        // an `IfcBooleanResult` or an `IfcCsgPrimitive3D`, NEVER another
        // `IfcCsgSolid`. Reject that case explicitly so a malformed (or
        // adversarial) file with a self-reference can't blow the stack on
        // unbounded recursion.
        match root.ifc_type {
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                BooleanClippingProcessor::new().process(&root, decoder, schema)
            }
            IfcType::IfcBlock => BlockProcessor::new().process(&root, decoder, schema),
            IfcType::IfcSphere => SphereProcessor::new().process(&root, decoder, schema),
            IfcType::IfcCsgSolid => Err(Error::geometry(
                "IfcCsgSolid TreeRootExpression must be IfcBooleanResult or \
                 IfcCsgPrimitive3D, not another IfcCsgSolid (spec violation)"
                    .to_string(),
            )),
            other => Err(Error::geometry(format!(
                "Unsupported IfcCsgSolid TreeRootExpression: {}",
                other
            ))),
        }
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcCsgSolid]
    }
}

/// `IfcSphere` — CSG primitive: a sphere of given radius centred at the
/// origin of its Position placement.
///
/// Attributes (inherits `IfcCsgPrimitive3D` → Position):
///   0: Position (`IfcAxis2Placement3D`)
///   1: Radius (`IfcPositiveLengthMeasure`)
pub struct SphereProcessor;

impl SphereProcessor {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SphereProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryProcessor for SphereProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
    ) -> Result<Mesh> {
        let radius = entity
            .get_float(1)
            .ok_or_else(|| Error::geometry("IfcSphere missing Radius".to_string()))?;

        if !radius.is_finite() || radius <= 0.0 {
            return Err(Error::geometry(format!(
                "IfcSphere requires finite positive radius, got {radius}",
            )));
        }

        let mut mesh = build_uv_sphere(radius, 24, 16);

        if let Some(pos_attr) = entity.get(0) {
            if !pos_attr.is_null() {
                if let Some(pos_entity) = decoder.resolve_ref(pos_attr)? {
                    if pos_entity.ifc_type == IfcType::IfcAxis2Placement3D {
                        let transform = parse_axis2_placement_3d(&pos_entity, decoder)?;
                        apply_transform(&mut mesh, &transform);
                    }
                }
            }
        }

        Ok(mesh)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcSphere]
    }
}

/// UV-sphere tessellation. `slices` segments around the equator, `stacks`
/// rings from pole to pole. Pole vertices are duplicated per slice so UV
/// seams don't share normals — sphere is closed and outward-facing.
fn build_uv_sphere(radius: f64, slices: usize, stacks: usize) -> Mesh {
    let slices = slices.max(3);
    let stacks = stacks.max(2);
    let vert_count = (stacks + 1) * (slices + 1);
    let tri_count = stacks * slices * 2;
    let mut mesh = Mesh::with_capacity(vert_count, tri_count * 3);

    for j in 0..=stacks {
        let v = j as f64 / stacks as f64;
        let phi = std::f64::consts::PI * v;
        let sin_phi = phi.sin();
        let cos_phi = phi.cos();
        for i in 0..=slices {
            let u = i as f64 / slices as f64;
            let theta = std::f64::consts::TAU * u;
            let nx = sin_phi * theta.cos();
            let ny = sin_phi * theta.sin();
            let nz = cos_phi;
            mesh.add_vertex(
                Point3::new(radius * nx, radius * ny, radius * nz),
                Vector3::new(nx, ny, nz),
            );
        }
    }

    let stride = slices + 1;
    for j in 0..stacks {
        for i in 0..slices {
            let a = (j * stride + i) as u32;
            let b = a + 1;
            let c = ((j + 1) * stride + i) as u32;
            let d = c + 1;
            // Skip degenerate pole triangles
            if j != 0 {
                mesh.add_triangle(a, c, b);
            }
            if j + 1 != stacks {
                mesh.add_triangle(b, c, d);
            }
        }
    }

    mesh
}

/// Build an axis-aligned box from `(0,0,0)` to `(x, y, z)` with one flat
/// quad per face. Six faces × 4 unique vertices × 2 triangles = 24 verts /
/// 12 tris. Vertices are duplicated per face so per-face normals stay
/// flat-shaded.
fn build_axis_aligned_box(x: f64, y: f64, z: f64) -> Mesh {
    let mut mesh = Mesh::with_capacity(24, 36);

    // Six faces. Each face lists its four corners in CCW order as seen
    // from outside the box, paired with its outward normal.
    let faces: [([Point3<f64>; 4], Vector3<f64>); 6] = [
        // -Z (bottom): viewed from below, CCW is (0,0,0) → (0,y,0) → (x,y,0) → (x,0,0)
        (
            [
                Point3::new(0.0, 0.0, 0.0),
                Point3::new(0.0, y, 0.0),
                Point3::new(x, y, 0.0),
                Point3::new(x, 0.0, 0.0),
            ],
            Vector3::new(0.0, 0.0, -1.0),
        ),
        // +Z (top)
        (
            [
                Point3::new(0.0, 0.0, z),
                Point3::new(x, 0.0, z),
                Point3::new(x, y, z),
                Point3::new(0.0, y, z),
            ],
            Vector3::new(0.0, 0.0, 1.0),
        ),
        // -Y (front)
        (
            [
                Point3::new(0.0, 0.0, 0.0),
                Point3::new(x, 0.0, 0.0),
                Point3::new(x, 0.0, z),
                Point3::new(0.0, 0.0, z),
            ],
            Vector3::new(0.0, -1.0, 0.0),
        ),
        // +Y (back)
        (
            [
                Point3::new(x, y, 0.0),
                Point3::new(0.0, y, 0.0),
                Point3::new(0.0, y, z),
                Point3::new(x, y, z),
            ],
            Vector3::new(0.0, 1.0, 0.0),
        ),
        // -X (left)
        (
            [
                Point3::new(0.0, y, 0.0),
                Point3::new(0.0, 0.0, 0.0),
                Point3::new(0.0, 0.0, z),
                Point3::new(0.0, y, z),
            ],
            Vector3::new(-1.0, 0.0, 0.0),
        ),
        // +X (right)
        (
            [
                Point3::new(x, 0.0, 0.0),
                Point3::new(x, y, 0.0),
                Point3::new(x, y, z),
                Point3::new(x, 0.0, z),
            ],
            Vector3::new(1.0, 0.0, 0.0),
        ),
    ];

    for (corners, normal) in faces {
        let base = (mesh.positions.len() / 3) as u32;
        for p in &corners {
            mesh.add_vertex(*p, normal);
        }
        mesh.add_triangle(base, base + 1, base + 2);
        mesh.add_triangle(base, base + 2, base + 3);
    }

    mesh
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn axis_aligned_box_is_closed_and_has_outward_normals() {
        let mesh = build_axis_aligned_box(2.0, 3.0, 4.0);
        assert_eq!(mesh.positions.len() / 3, 24);
        assert_eq!(mesh.indices.len() / 3, 12);

        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for chunk in mesh.positions.chunks_exact(3) {
            for i in 0..3 {
                min[i] = min[i].min(chunk[i]);
                max[i] = max[i].max(chunk[i]);
            }
        }
        assert_eq!(min, [0.0, 0.0, 0.0]);
        assert_eq!(max, [2.0, 3.0, 4.0]);

        // Each face's normal should match its outward axis.
        let mut faces_seen = [false; 6];
        for chunk in mesh.normals.chunks_exact(12) {
            let nx = chunk[0];
            let ny = chunk[1];
            let nz = chunk[2];
            let label = match (nx, ny, nz) {
                (x, _, _) if x > 0.5 => 0,
                (x, _, _) if x < -0.5 => 1,
                (_, y, _) if y > 0.5 => 2,
                (_, y, _) if y < -0.5 => 3,
                (_, _, z) if z > 0.5 => 4,
                (_, _, z) if z < -0.5 => 5,
                _ => panic!("non-axial normal"),
            };
            faces_seen[label] = true;
        }
        assert!(faces_seen.iter().all(|&seen| seen), "missing a face");
    }
}
