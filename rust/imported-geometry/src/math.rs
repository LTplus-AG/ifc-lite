// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use crate::{ImportError, MeshOutput, PointsOutput, RawMatrix, RawMesh};
const IDENTITY: [f32; 16] = [1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.];
pub fn stage_values(values: &[f64]) -> Vec<f32> { values.iter().map(|v| *v as f32).collect() }
pub fn stage_transform(stack: &[RawMatrix], canonical: bool) -> Option<[f32; 16]> {
    let mut world: Option<[f32; 16]> = None;
    for matrix in stack {
        let mut local = IDENTITY;
        for row in 0..4 { for col in 0..4 {
            if let Some(value) = matrix.get(row).and_then(|r| r.get(col)) { local[row*4+col] = *value as f32; }
        }}
        world = Some(match world {
            None => local,
            Some(parent) => {
                let mut out = [0.; 16];
                for row in 0..4 { for col in 0..4 {
                    let mut sum = 0.0_f64;
                    for k in 0..4 { sum += local[row*4+k] as f64 * parent[k*4+col] as f64; }
                    out[row*4+col] = sum as f32;
                }}
                out
            }
        });
        if canonical && world == Some(IDENTITY) { world = None; }
    }
    world
}
pub fn compute_normal_matrix(m: &[f32]) -> Option<Vec<f32>> {
    let at = |i| m.get(i).copied().unwrap_or(f32::NAN) as f64;
    let (a,b,c,d,e,f,g,h,i)=(at(0),at(1),at(2),at(4),at(5),at(6),at(8),at(9),at(10));
    let det = a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
    if !det.is_finite() || det.abs() < 1e-12 { return None; }
    let inv = 1./det;
    Some([e*i-f*h,-(d*i-f*g),d*h-e*g,-(b*i-c*h),a*i-c*g,-(a*h-b*g),b*f-c*e,-(a*f-c*d),a*e-b*d].map(|x| (x*inv) as f32).to_vec())
}
fn at(values: &[f32], i: usize) -> f64 { values.get(i).copied().unwrap_or(f32::NAN) as f64 }
/// Float offset of a vertex's first component. `None` unless all three
/// components (`offset..=offset + 2`) are representable, so no later `+1`/`+2`
/// can wrap (on wasm32 index 0x55555555 multiplies to exactly `usize::MAX`).
pub(crate) fn vertex_offset(index: usize) -> Option<usize> {
    let offset = index.checked_mul(3)?;
    offset.checked_add(2)?;
    Some(offset)
}
pub fn compute_normals(positions: &[f32], indices: &[u32]) -> Vec<f32> {
    let mut normals = vec![0.; positions.len()];
    for tri in indices.chunks(3) {
        let ids = [0, 1, 2].map(|i| tri.get(i).and_then(|x| vertex_offset(*x as usize)).unwrap_or(usize::MAX - 2));
        let (a,b,c)=(ids[0],ids[1],ids[2]);
        let e1=[at(positions,b)-at(positions,a),at(positions,b+1)-at(positions,a+1),at(positions,b+2)-at(positions,a+2)];
        let e2=[at(positions,c)-at(positions,a),at(positions,c+1)-at(positions,a+1),at(positions,c+2)-at(positions,a+2)];
        let n=[e1[1]*e2[2]-e1[2]*e2[1],e1[2]*e2[0]-e1[0]*e2[2],e1[0]*e2[1]-e1[1]*e2[0]];
        for id in ids { for (j, value) in n.iter().enumerate() { if let Some(v)=normals.get_mut(id+j) { *v=(*v as f64+value) as f32; }}}
    }
    for chunk in normals.chunks_mut(3) {
        let len=(at(chunk,0).powi(2)+at(chunk,1).powi(2)+at(chunk,2).powi(2)).sqrt();
        if len>0. { for v in chunk { *v=(*v as f64/len) as f32; } }
    }
    normals
}
fn component(row: &[f64], i: usize) -> f64 { row.get(i).copied().unwrap_or(f64::NAN) }
fn denominator(p: [f64; 3], m: &[f32;16]) -> f64 { m[3] as f64*p[0]+m[7] as f64*p[1]+m[11] as f64*p[2]+m[15] as f64 }
fn bad_w(w:f64)->bool { !w.is_finite() || w.abs()<1e-12 }
fn placed(p:[f64;3],m:&[f32;16],w:f64,reciprocal:bool)->[f64;3] {
    let mut out=[0.;3];
    for c in 0..3 {
        let n=m[c] as f64*p[0]+m[4+c] as f64*p[1]+m[8+c] as f64*p[2]+m[12+c] as f64;
        out[c]=if reciprocal { n*(1./w) } else { n/w };
    }
    out
}
fn yup(p:[f64;3])->[f32;3] { [p[0] as f32,p[2] as f32,(-p[1]) as f32] }
fn to_uint32(v:f64)->u32 {
    if !v.is_finite() || v==0. {0} else {v.trunc().rem_euclid(4294967296.) as u32}
}
pub(crate) fn mesh(source:&RawMesh,stack:&[RawMatrix])->Result<MeshOutput,ImportError> {
    let transform=stage_transform(stack,true);
    let mut positions=Vec::with_capacity(source.points.len()*3);
    for row in &source.points {
        let mut p=[component(row,0),component(row,1),component(row,2)];
        if let Some(m)=transform { let w=denominator(p,&m); if bad_w(w) {return Err(ImportError::HomogeneousMesh);} p=placed(p,&m,w,false); }
        positions.extend(yup(p));
    }
    let mut indices=Vec::new();
    if let Some(counts)=source.face_vertex_counts.as_ref().filter(|x| !x.is_empty()) {
        // Untrusted counts. The walk ends at the first count that is not a finite
        // non-negative integer. `offset` stays within 0..=indices.len() and a face
        // never fans past the indices that exist, so the total number of emitted
        // triangles is at most indices.len() and work stays bounded.
        let len=source.face_vertex_indices.len();
        let get=|index:usize| source.face_vertex_indices.get(index).copied().unwrap_or(f64::NAN);
        let mut offset=0usize;
        for &count in counts {
            if !count.is_finite() || count<0. || count.fract()!=0. { break; }
            let available=len-offset;
            // Saturating: counts beyond the remaining indices clamp to them.
            let n=if count>=available as f64 {available} else {count as usize};
            for i in 1..n.saturating_sub(1) {
                indices.extend([to_uint32(get(offset)),to_uint32(get(offset+i)),to_uint32(get(offset+i+1))]);
            }
            offset+=n;
            if count>available as f64 { break; }
        }
    } else { indices.extend(source.face_vertex_indices.iter().map(|x|to_uint32(*x))); }
    let normals=match &source.normals {
        None=>compute_normals(&positions,&indices),
        Some(raw)=>{
            let normal=transform.and_then(|m|compute_normal_matrix(&m));
            let mut out=Vec::with_capacity(raw.len()*3);
            for row in raw {
                let mut p=[component(row,0),component(row,1),component(row,2)];
                if let Some(ref m)=normal {
                    let n=[p[0]*m[0] as f64+p[1]*m[3] as f64+p[2]*m[6] as f64,p[0]*m[1] as f64+p[1]*m[4] as f64+p[2]*m[7] as f64,p[0]*m[2] as f64+p[1]*m[5] as f64+p[2]*m[8] as f64];
                    let len=(n[0].powi(2)+n[1].powi(2)+n[2].powi(2)).sqrt();
                    p=if len>0. {n.map(|v|v/len)}else{n};
                }
                out.extend(yup(p));
            }
            out
        }
    };
    Ok(MeshOutput{positions,normals,indices})
}
pub(crate) fn points(source:&[f64],stack:&[RawMatrix])->Result<PointsOutput,ImportError> {
    let transform=stage_transform(stack,false);
    let staged=stage_values(source);
    let mut positions=Vec::with_capacity(source.len());
    let mut min=[f64::INFINITY;3]; let mut max=[f64::NEG_INFINITY;3];
    for (index,chunk) in staged.chunks(3).enumerate() {
        let mut p=[at(chunk,0),at(chunk,1),at(chunk,2)];
        if let Some(m)=transform { let w=denominator(p,&m); if index==0 && staged.len()>=3 && bad_w(w) {return Err(ImportError::HomogeneousPoints);} p=placed(p,&m,w,true); }
        let out=yup(p);
        positions.extend_from_slice(&out[..chunk.len()]);
        for j in 0..3 { let v=if j<chunk.len(){out[j] as f64}else{f64::NAN}; if v<min[j]{min[j]=v;}
            if v>max[j]{max[j]=v;} }
    }
    Ok(PointsOutput{positions,min,max})
}
