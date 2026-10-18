// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcSphere` — the UV-sphere CSG leaf primitive.
//!
//! Production lowering owns the raw radius, quality and Position; evaluation
//! replays the same UV-sphere builder without requiring an IFC decoder.

use super::csg_primitive::plan;
use crate::router::GeometryProcessor;
use crate::{Mesh, Result, TessellationQuality, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Point3;

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

    pub(crate) fn lower(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Result<plan::SpherePlan> {
        plan::lower_sphere(entity, decoder, quality)
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
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        Ok(self.lower(entity, decoder, quality)?.evaluate())
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcSphere]
    }
}

/// UV-sphere tessellation. `slices` segments around the equator, `stacks`
/// rings from pole to pole. Pole vertices are duplicated per slice so UV
/// seams don't share normals — sphere is closed and outward-facing.
pub(super) fn build_uv_sphere(radius: f64, slices: usize, stacks: usize) -> Mesh {
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
