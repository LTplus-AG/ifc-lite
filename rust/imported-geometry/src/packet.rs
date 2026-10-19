// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Versioned little-endian typed packets. f64 input and f32 output preserve
//! nonfinite numbers and signed zero, unlike a JSON bridge.
use crate::*;
struct Reader<'a> { data: &'a [u8], offset: usize }
impl Reader<'_> {
    fn bytes<const N:usize>(&mut self)->Result<[u8;N],ImportError> {
        let end=self.offset.checked_add(N).ok_or(ImportError::InvalidPacket)?;
        let value=self.data.get(self.offset..end).ok_or(ImportError::InvalidPacket)?.try_into().map_err(|_|ImportError::InvalidPacket)?;
        self.offset=end; Ok(value)
    }
    fn u32(&mut self)->Result<u32,ImportError>{Ok(u32::from_le_bytes(self.bytes()?))}
    fn u64(&mut self)->Result<u64,ImportError>{Ok(u64::from_le_bytes(self.bytes()?))}
    fn values(&mut self)->Result<Vec<f64>,ImportError>{
        let n=self.u32()? as usize;
        if n>(self.data.len()-self.offset)/8 {return Err(ImportError::InvalidPacket);}
        (0..n).map(|_|Ok(f64::from_le_bytes(self.bytes()?))).collect()
    }
    fn rows(&mut self)->Result<Vec<Vec<f64>>,ImportError>{
        let n=self.u32()? as usize;
        if n>(self.data.len()-self.offset)/4 {return Err(ImportError::InvalidPacket);}
        (0..n).map(|_|self.values()).collect()
    }
    fn stack(&mut self)->Result<Vec<RawMatrix>,ImportError>{
        let n=self.u32()? as usize;
        if n>(self.data.len()-self.offset)/4 {return Err(ImportError::InvalidPacket);}
        (0..n).map(|_|self.rows()).collect()
    }
}
fn length(value:usize)->Result<u32,ImportError> {u32::try_from(value).map_err(|_|ImportError::InvalidPacket)}
fn floats(out:&mut Vec<u8>,values:&[f32])->Result<(),ImportError> {
    out.extend(length(values.len())?.to_le_bytes());
    for value in values {out.extend(value.to_le_bytes());}
    Ok(())
}
fn dispatch(input:&[u8])->Result<Vec<u8>,ImportError> {
    let mut r=Reader{data:input,offset:0};
    if r.u32()?!=1 {return Err(ImportError::InvalidPacket);}
    let kind=r.u32()?;
    if kind>=100 {return crate::graph_packet::dispatch(input);}
    let mut out=Vec::new();
    match kind {
        1 => {let m=stage_transform(&r.stack()?,true);floats(&mut out,m.as_ref().map_or(&[],|m|m.as_slice()))?;}
        2|3 => {
            let identity=ImportIdentity{store:r.u64()?,revision:r.u64()?,definition:r.u64()?,occurrence:r.u64()?};
            let transform_stack=r.stack()?;
            let source=if kind==2 {
                let points=r.rows()?;let face_vertex_indices=r.values()?;
                let face_vertex_counts=if r.u32()?!=0 {Some(r.values()?)}else{None};
                let normals=if r.u32()?!=0 {Some(r.rows()?)}else{None};
                ImportedSource::Mesh(RawMesh{points,face_vertex_indices,face_vertex_counts,normals})
            }else{ImportedSource::Points(r.values()?)};
            let assembled=scene::evaluate(ImportedDefinition{identity,source,transform_stack})?;
            match assembled.output {
                ImportedOutput::Mesh(mesh)=>{
                    floats(&mut out,&mesh.positions)?;floats(&mut out,&mesh.normals)?;
                    out.extend(length(mesh.indices.len())?.to_le_bytes());
                    for value in mesh.indices {out.extend(value.to_le_bytes());}
                }
                ImportedOutput::Points(points)=>{
                    floats(&mut out,&points.positions)?;
                    for value in points.min.into_iter().chain(points.max) {out.extend(value.to_le_bytes());}
                }
            }
        }
        4=>floats(&mut out,&stage_values(&r.values()?))?,
        5=>{let values=stage_values(&r.values()?);let m=compute_normal_matrix(&values);floats(&mut out,m.as_deref().unwrap_or(&[]))?;}
        6=>{
            let positions=stage_values(&r.values()?);let n=r.u32()? as usize;
            if n>(r.data.len()-r.offset)/4 {return Err(ImportError::InvalidPacket);}
            let indices=(0..n).map(|_|r.u32()).collect::<Result<Vec<_>,_>>()?;
            floats(&mut out,&compute_normals(&positions,&indices))?;
        }
        _=>return Err(ImportError::InvalidPacket),
    }
    if r.offset!=input.len(){return Err(ImportError::InvalidPacket);}
    Ok(out)
}
/// Output: u32 total byte length, u32 status (0 success, 1 UTF-8 error), payload.
pub fn process_packet(input:&[u8])->Vec<u8> {
    let (status,payload)=match dispatch(input){Ok(out)=>(0u32,out),Err(error)=>(1,error.to_string().into_bytes())};
    let Some(total)=payload.len().checked_add(8).and_then(|n|u32::try_from(n).ok()) else {
        return process_packet(&[]);
    };
    let mut out=Vec::with_capacity(total as usize);
    out.extend(total.to_le_bytes());out.extend(status.to_le_bytes());out.extend(payload);out
}

// The small synchronous artifact needs no wasm-bindgen runtime or imports.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn imported_alloc(len:usize)->*mut u8 { Box::into_raw(vec![0u8;len].into_boxed_slice()) as *mut u8 }
/// # Safety
/// The pointer and length must be the exact allocation returned by this module.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub unsafe extern "C" fn imported_free(ptr:*mut u8,len:usize) { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr,len))); }
/// # Safety
/// The input must reference a live allocation of `len` bytes in module memory.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub unsafe extern "C" fn imported_run(ptr:*const u8,len:usize)->*mut u8 {
    let out=process_packet(std::slice::from_raw_parts(ptr,len));
    Box::into_raw(out.into_boxed_slice()) as *mut u8
}
