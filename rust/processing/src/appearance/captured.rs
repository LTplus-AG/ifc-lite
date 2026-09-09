// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{captured_types::*,annotation_types::*,annotation::plan_textured_product};
const MAX_ROWS:usize=200_000;

fn validate(mesh:&CapturedMesh)->Result<(),String> {
    if [mesh.positions.len(),mesh.triangles.len(),mesh.uvs.len()].iter().any(|n|*n==0 || *n>MAX_ROWS)
        || mesh.uv_triangles.len()!=mesh.triangles.len() {
        return Err("Captured mesh needs 1..200000 position, triangle and UV rows, with one UV triangle per face".into());
    }
    if mesh.positions.iter().flatten().any(|v|!v.is_finite() || v.abs()>1e9)
        || mesh.uvs.iter().flatten().any(|v|!v.is_finite() || !(0. ..=1.).contains(v)) {
        return Err("Captured coordinates must be finite world metres within +/-1e9 and UVs within the non-repeating image".into());
    }
    for (face,uv) in mesh.triangles.iter().zip(&mesh.uv_triangles) {
        if face.iter().any(|i|*i as usize>=mesh.positions.len()) || uv.iter().any(|i|*i as usize>=mesh.uvs.len()) {
            return Err("Captured geometry or UV triangle index is out of bounds".into());
        }
        let [a,b,c]=face.map(|i|mesh.positions[i as usize]);
        let ab:[f64;3]=std::array::from_fn(|i|b[i]-a[i]);
        let ac:[f64;3]=std::array::from_fn(|i|c[i]-a[i]);
        let cross=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
        if cross.iter().map(|v|v*v).sum::<f64>()<=1e-24 {
            return Err("Captured mesh contains a degenerate triangle".into());
        }
    }
    Ok(())
}
/// Author a bounded existing captured surface as IfcBuildingElementProxy.
/// Decoding, reconstruction, classification and image ownership stay with callers.
pub fn plan_captured_mesh(bytes:&[u8],request:&CapturedMeshRequest)->Result<CapturedMeshPlan,String> {
    validate(&request.mesh)?;
    if request.name.trim().is_empty() { return Err("Captured object requires a Name".into()); }
    let r=AnnotationPlaneRequest {schema:request.schema.clone(),source_revision:request.source_revision.clone(),
        next_express_id:request.next_express_id,container_id:request.container_id,global_id:request.global_id.clone(),
        containment_global_id:request.containment_global_id.clone(),name:request.name.clone(),image_uri:request.image_uri.clone(),
        frame:AnnotationPlaneFrame {origin:request.mesh.positions[0],axis_u:[1.,0.,0.],axis_v:[0.,1.,0.],size_metres:[1.,1.]} };
    let result=plan_textured_product(bytes,&r,Some(&request.mesh),[request.repeat_s,request.repeat_t])?;
    let uvs=result.mesh.uvs.as_ref().ok_or("Captured image coordinates were lost")?;
    // Check the actual native triangle corners, including seams and image V.
    // This is a refusal boundary for float precision loss, never a silent repair.
    for (face,indices) in result.mesh.indices.chunks_exact(3).enumerate() {
        for (corner,index) in indices.iter().enumerate() {
            let p=request.mesh.positions[request.mesh.triangles[face][corner] as usize];
            let uv=request.mesh.uvs[request.mesh.uv_triangles[face][corner] as usize];
            let i=*index as usize;
            for (axis,expected) in p.iter().enumerate() {
                let actual=f64::from(result.mesh.positions[i*3+axis])+result.mesh.origin[axis]+result.rtc_offset[axis];
                if (actual-expected).abs()>1e-4 { return Err("Captured mesh loses world precision in canonical geometry".into()); }
            }
            if (f64::from(uvs[i*2])-uv[0]).abs()>1e-6 || (f64::from(uvs[i*2+1])-(1.-uv[1])).abs()>1e-6 {
                return Err("Captured triangle image correspondence was not preserved".into());
            }
        }
    }
    Ok(CapturedMeshPlan {plan:result.plan,object_id:result.product_id,geometry_item_id:result.geometry_item_id,
        mesh:result.mesh,coordinate_space:"ifc-z-up",rtc_offset:result.rtc_offset})
}

#[cfg(test)]
#[path="captured_tests.rs"]
mod tests;
