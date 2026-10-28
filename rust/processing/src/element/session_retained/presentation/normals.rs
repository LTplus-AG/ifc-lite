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
