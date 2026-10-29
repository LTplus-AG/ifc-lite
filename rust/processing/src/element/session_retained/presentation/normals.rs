// SPDX-License-Identifier: MPL-2.0
//! Apply mesh normals before the whole-product publication boundary.
use super::{Context, Requirement, ShapeOnlyProduct};
use super::super::RetainedExecutionError;

#[path = "normals_mesh.rs"]
mod mesh;

pub(super) fn prepare(product: &mut ShapeOnlyProduct, context: &Context<'_>)
    -> Result<(), RetainedExecutionError> {
    for part in &mut product.parts {
        mesh::validate(part)?;
        require_frame(part)?;
        let mut normals = Vec::new();
        let count = part.indices.len().checked_mul(3)
            .ok_or_else(|| RetainedExecutionError::Stopped(ifc_lite_geometry::resource::overflow()))?;
        product._storage.reserve(context.resources, &mut normals, count)?;
        normals.resize(count, 0.);
        part.normals = Some(normals);
    }
    Ok(())
}

pub(super) fn apply(product: &mut ShapeOnlyProduct, context: &Context<'_>)
    -> Result<[Requirement; 1], RetainedExecutionError> {
    for part in &mut product.parts {
        require_frame(part)?;
        part.normals = Some(mesh::corner_normals(part, context.angle_degrees, context.resources, &mut product._storage)?);
    }
    Ok([Requirement::SurfaceNormals])
}


pub(super) fn apply_plane(part: &mut super::super::publication::ShapePart, from_part: &[f64;16],
    origin: [f64;3], normal: [f64;3], triangles: &[usize], resources: &super::OwnedResourceContext)
    -> Result<bool,RetainedExecutionError> {
    mesh::plane::apply(part,from_part,origin,normal,triangles,resources)
}

fn require_frame(part: &super::super::publication::ShapePart) -> Result<(), RetainedExecutionError> {
    // M10 handoff: mirrored publication must flip winding AND normals together.
    if !mesh::positive_frame(part)? {
        return Err(RetainedExecutionError::Unsupported(super::super::Unsupported::
            RetainedFinalPublicationRequiresOpeningLayerAppearanceFaceProofs));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn m11_n_7955_mirror_cannot_publish_until_m10_flips_winding_and_normals() {
        let mut part = super::super::super::publication::ShapePart {
            layer: None, capped_volume_m3: None,
            positions: vec![], indices: vec![], revision_local_faces: vec![],
            world_from_object: [-2.,0.,0.,0., 0.,3.,0.,0., 0.,0.,4.,0., 0.,0.,0.,1.],
            curved: false, halfspace_clipped: false, normals: None, appearance: None, faces: None, instance_key: None,
        };
        assert_eq!(require_frame(&part).unwrap_err().refusal().0.code(), "incomplete");
        part.world_from_object[0] = 2.;
        require_frame(&part).unwrap();
    }
}
