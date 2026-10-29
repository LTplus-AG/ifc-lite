// SPDX-License-Identifier: MPL-2.0
//! M11-F's attributed source plane supplies the exact planar normal (#7955).
//! Verify the whole kernel face before replacing its per-corner facet means.
use super::{cross, dot, length, sub, unit, work, world_vector,
    OwnedResourceContext, RetainedExecutionError, ShapePart};
use ifc_lite_geometry::math::mat4;

// Same registered M11-F faceIncidence, in world metres.
const FACE_INCIDENCE: f64 = 1e-6;

fn point(part: &ShapePart, index: u32) -> [f64;3] {
    let i = index as usize * 3;
    [part.positions[i],part.positions[i+1],part.positions[i+2]]
}

pub(in super::super) fn apply(part: &mut ShapePart, from_part: &[f64;16], origin: [f64;3],
    source_normal: [f64;3], triangles: &[usize], resources: &OwnedResourceContext)
    -> Result<(),RetainedExecutionError> {
    // These are the controller's composed frames, including Boolean lineage.
    // Use the canonical matrix home; no placement walk or new frame derivation.
    let Some(into_part) = mat4::affine_inverse(&mat4::transpose(from_part)) else {return Ok(());};
    let into_world = mat4::mul(&mat4::transpose(&part.world_from_object),&into_part);
    let helper = if source_normal[0].abs() < 0.9 {[1.,0.,0.]} else {[0.,1.,0.]};
    let u = unit(cross(source_normal,helper))?;
    let v = cross(source_normal,u);
    // Transform tangent directions before taking their cross product: scale
    // and mirrors need no separate normal-matrix or handedness convention.
    let mut normal = unit(cross(mat4::transform_vector(&into_world,u),mat4::transform_vector(&into_world,v)))?;
    let plane_origin = mat4::transform_point(&into_part,origin);
    let mut majority = 0_i64;
    for &t in triangles {
        work(resources,1)?;
        let p: [[f64;3];3] = std::array::from_fn(|c| point(part,part.indices[t*3+c]));
        for vertex in p {
            // Translation cancels before transforming, including at survey offsets.
            let distance = dot(world_vector(&part.world_from_object,sub(vertex,plane_origin)),normal).abs();
            if !distance.is_finite() || distance > FACE_INCIDENCE {return Ok(());}
        }
        let facet = cross(world_vector(&part.world_from_object,sub(p[1],p[0])),
            world_vector(&part.world_from_object,sub(p[2],p[0])));
        if length(facet) > 0. {majority += if dot(facet,normal) >= 0. {1} else {-1};}
    }
    if majority == 0 {return Ok(());}
    if majority < 0 {normal = normal.map(|v| -v);}
    // No corner is changed until every face vertex has passed. On failure the
    // original per-corner rule remains, and the independent source gate judges it.
    let normals = part.normals.as_mut().ok_or_else(super::invalid)?;
    for &t in triangles {
        work(resources,1)?;
        for c in 0..3 {normals[t*9+c*3..t*9+c*3+3].copy_from_slice(&normal);}
    }
    Ok(())
}
