// SPDX-License-Identifier: MPL-2.0
//! M10 decoder-only reading of mapping operators: the frame a map applies, and
//! whether it is nonrigid. Production geometry is never consulted.
use super::{affine::{axes,columns,direction,Frame},math::*};
use ifc_lite_core::{slot, EntityDecoder, IfcType};

fn inverse_rigid(m:&Frame) -> Frame {
    let mut inv=IDENTITY;
    for i in 0..3 {for j in 0..3 {inv[i+4*j]=m[j+4*i];}}
    let p=vector(&inv,[-m[12],-m[13],-m[14]]);inv[12..15].copy_from_slice(&p);inv
}
/// IfcBaseAxis: project Axis1 against D3 and Axis2 against both, preserving its sign.
/// The 2D operators have no Axis3 (their attribute 4 is Scale2); the plane normal
/// is +Z and Z keeps the uniform Scale, as the production reader does.
pub(super) fn mapping(d:&mut EntityDecoder<'_>, source:u32,target:u32) -> Option<(Frame,Vec<u32>)> {
    let map=d.decode_by_id(source).ok()?;
    let origin=axes(d,map.ref_at(slot::IfcRepresentationMap::MAPPING_ORIGIN))?;
    let rep=d.decode_by_id(map.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION)?).ok()?;
    let items=rep.ref_list_at(slot::IfcRepresentation::ITEMS)?;
    let op=d.decode_by_id(target).ok()?;
    use slot::IfcCartesianTransformationOperator as O;
    // Reject unsupported records before any typed-slot access (Axis3 is a 3D slot).
    let two_d=match op.ifc_type {
        IfcType::IfcCartesianTransformationOperator2D|IfcType::IfcCartesianTransformationOperator2DnonUniform=>true,
        IfcType::IfcCartesianTransformationOperator3D|IfcType::IfcCartesianTransformationOperator3DnonUniform=>false,
        _=>return None,
    };
    let z=if two_d {[0.,0.,1.]} else {
        direction(d,op.ref_at(slot::IfcCartesianTransformationOperator3D::AXIS3),[0.,0.,1.])?
    };
    let default=if z[0].abs()>0.999999 {[0.,1.,0.]} else {[1.,0.,0.]};
    let (axis1,axis2)=(op.ref_at(O::AXIS1),op.ref_at(O::AXIS2));
    let x=match (two_d,axis1,axis2) {
        // IfcBaseAxis 2D: Axis2 alone fixes the frame; X is its clockwise perpendicular.
        (true,None,Some(y)) => {let y=unit(d.direction3(y).ok()?)?;[y[1],-y[0],0.]}
        _ => direction(d,axis1,default)?,
    };
    let x=unit(sub(x,z.map(|v|v*dot(x,z))))?;
    // IfcBaseAxis 2D (IfcOrthogonalComplement): without Axis2, Y is the counter-clockwise complement of X.
    let y=direction(d,axis2,if two_d {[-x[1],x[0],0.]} else {[0.,1.,0.]})?;
    // With Axis2 omitted the +Y default can lie in the plane of Z and X; there is nothing left to
    // project, and production takes Z x X (a rigid rotation). Only that collapse falls back.
    let y=match unit(sub(sub(y,z.map(|v|v*dot(y,z))),x.map(|v|v*dot(y,x)))) {
        Some(y)=>y,
        None if axis2.is_none()=>unit(cross(z,x))?,
        None=>return None,
    };
    let s=op.real_at(O::SCALE).unwrap_or(1.);
    let (s2,s3)=match op.ifc_type {
        IfcType::IfcCartesianTransformationOperator3DnonUniform=>
            (op.real_at(slot::IfcCartesianTransformationOperator3DnonUniform::SCALE2).unwrap_or(s),
             op.real_at(slot::IfcCartesianTransformationOperator3DnonUniform::SCALE3).unwrap_or(s)),
        IfcType::IfcCartesianTransformationOperator2DnonUniform=>
            (op.real_at(slot::IfcCartesianTransformationOperator2DnonUniform::SCALE2).unwrap_or(s),s),
        _=>(s,s),
    };
    let matrix=columns(x.map(|v|v*s),y.map(|v|v*s2),z.map(|v|v*s3),d.point3(op.ref_at(O::LOCAL_ORIGIN)?).ok()?);
    Some((multiply(&matrix,&inverse_rigid(&origin)),items))
}
// Independent symmetric Jacobi eigensolve for singular values; no production SVD.
pub(super) fn stretches(m:&Frame) -> Option<(f64,f64)> {
    let mut a=[[0.;3];3];
    for i in 0..3 {for j in 0..3 {a[i][j]=(0..3).map(|k|m[4*i+k]*m[4*j+k]).sum();}}
    for _ in 0..32 {
        let (p,q)=[(0,1),(0,2),(1,2)].into_iter().max_by(|&(p,q),&(r,s)|a[p][q].abs().total_cmp(&a[r][s].abs()))?;
        if a[p][q].abs()<=1e-15*a[p][p].abs().max(a[q][q].abs()) {break}
        let theta=0.5*(2.*a[p][q]).atan2(a[q][q]-a[p][p]);let (s,c)=theta.sin_cos();
        let (app,aqq,apq)=(a[p][p],a[q][q],a[p][q]);
        let k=3-p-q; // the third axis of this 3x3 Jacobi rotation
        let (kp,kq)=(a[k][p],a[k][q]);a[k][p]=c*kp-s*kq;a[p][k]=a[k][p];a[k][q]=s*kp+c*kq;a[q][k]=a[k][q];
        a[p][p]=c*c*app-2.*s*c*apq+s*s*aqq;a[q][q]=s*s*app+2.*s*c*apq+c*c*aqq;a[p][q]=0.;a[q][p]=0.;
    }
    let min=(0..3).map(|i|a[i][i]).fold(f64::INFINITY,f64::min).sqrt();
    let max=(0..3).map(|i|a[i][i]).fold(0.,f64::max).sqrt();
    (min>0.&&max.is_finite()).then_some((min,max))
}
pub(super) fn nonrigid(m:&Frame) -> bool {
    // No singular values to report means a singular map: never rigid.
    let Some((min,max))=stretches(m) else {return true};
    dot([m[0],m[1],m[2]],cross([m[4],m[5],m[6]],[m[8],m[9],m[10]]))<0.
        || (min-1.).abs()>1e-12 || (max-1.).abs()>1e-12
}
