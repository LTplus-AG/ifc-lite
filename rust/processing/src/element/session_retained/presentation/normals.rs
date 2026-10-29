// SPDX-License-Identifier: MPL-2.0
//! Apply mesh normals before the whole-product publication boundary.
use super::{Context, Requirement, ShapeOnlyProduct};
use super::super::RetainedExecutionError;

#[path = "normals_mesh.rs"]
mod mesh;

pub(super) fn apply(product: &mut ShapeOnlyProduct, context: &Context<'_>)
    -> Result<[Requirement; 1], RetainedExecutionError> {
    for part in &mut product.parts {
        part.normals = Some(mesh::corner_normals(part, context.resources, &mut product._storage)?);
    }
    Ok([Requirement::SurfaceNormals])
}


pub(super) fn apply_plane(part: &mut super::super::publication::ShapePart, from_part: &[f64;16],
    origin: [f64;3], normal: [f64;3], triangles: &[usize], resources: &super::OwnedResourceContext)
    -> Result<(),RetainedExecutionError> {
    mesh::plane::apply(part,from_part,origin,normal,triangles,resources)
}
