// SPDX-License-Identifier: MPL-2.0
//! Structural validation of actual opcode20 evidence, not numerical qualification.
use crate::{protocol::WireHandle, NumericalOutcome};
#[path="plane_source.rs"]
mod source;
pub use source::{SourceRectangleDomain, SourceRectangleEdge};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaneSide { Positive, Negative }
impl PlaneSide {
    pub(crate) fn code(self) -> i32 { match self { Self::Positive => 1, Self::Negative => -1 } }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaneClipMode { Intersection, Difference }
impl PlaneClipMode {
    pub(crate) fn code(self) -> u32 { match self { Self::Intersection => 2, Self::Difference => 3 } }
}

/// Actual raw cylinder coefficients; revision-local face indices are not ancestry.
#[derive(Debug, Clone, PartialEq)]
pub struct CylinderDomain {
    source_face: u32,
    swap_uv: bool,
    inside_out: bool,
    origin: [f64;3],
    basis: [f64;9],
    radius: f64,
    step_v: [f64;2],
}
impl CylinderDomain {
    pub fn source_face(&self) -> u32 { self.source_face }
    pub fn swap_uv(&self) -> bool { self.swap_uv }
    pub fn inside_out(&self) -> bool { self.inside_out }
    pub fn origin(&self) -> &[f64;3] { &self.origin }
    pub fn basis(&self) -> &[f64;9] { &self.basis }
    pub fn radius(&self) -> f64 { self.radius }
    pub fn step_v(&self) -> &[f64;2] { &self.step_v }
}
/// Output-only evidence. No public constructor or receipt accepts this as input.
#[derive(Debug, Clone, PartialEq)]
pub struct PlaneCertificate {
    version: u32,
    rectangles: Vec<SourceRectangleDomain>,
    input: WireHandle,
    output: WireHandle,
    method: u32,
    outcome: NumericalOutcome,
    faces: u32,
    edges: u32,
    coefficients: u32,
    basis: [f64;9],
    domain: [f64;6],
    cutter: [f64;6],
    clearance: f64,
    cylinders: Vec<CylinderDomain>,
}
impl PlaneCertificate {
    pub fn version(&self) -> u32 { self.version }
    pub fn source_rectangles(&self) -> &[SourceRectangleDomain] { &self.rectangles }
    /// Wire identity evidence alone grants no lease or execution authority.
    pub fn input_handle(&self) -> WireHandle { self.input }
    pub fn output_handle(&self) -> WireHandle { self.output }
    pub fn method(&self) -> u32 { self.method }
    pub fn outcome(&self) -> NumericalOutcome { self.outcome }
    pub fn topology_counts(&self) -> (u32,u32,u32) { (self.faces,self.edges,self.coefficients) }
    pub fn basis(&self) -> &[f64;9] { &self.basis }
    pub fn domain(&self) -> &[f64;6] { &self.domain }
    pub fn cutter(&self) -> &[f64;6] { &self.cutter }
    pub fn clearance(&self) -> f64 { self.clearance }
    pub fn cylinders(&self) -> &[CylinderDomain] { &self.cylinders }

    /// Payload excludes the twelve-byte response header, includes output handle.
    pub(crate) fn decode(bytes: &[u8], input: WireHandle, plane: [f64;6], side: PlaneSide,
        mode: PlaneClipMode) -> Result<Self, &'static str>
    {
        validate_plane(&plane)?;
        if bytes.len()<312 || bytes.len()>crate::protocol::MAX_PLANE_PAYLOAD_BYTES { return Err("invalid plane response size"); }
        let output=WireHandle::from_bytes(&bytes[..16]).map_err(|_| "invalid plane output")?;
        let c=&bytes[16..];
        let u=|i| u32::from_le_bytes(c[i..i+4].try_into().expect("four bytes"));
        let handle=|i| WireHandle::from_bytes(&c[i..i+16]).expect("sixteen bytes");
        let count=u(292) as usize;
        let version=u(0);
        if count>16 { return Err("invalid cylinder count"); }
        let base=312+136*count;
        if base>bytes.len() || !matches!(version,1|2) || u(8)!=1 || u(12)>1 ||
            handle(16)!=input || handle(32)!=output || output.session!=input.session ||
            input.session==0 || input.generation==0 || output.generation==0 || output==input ||
            u(48)!=side.code() as u32 || u(52)!=mode.code() {
            return Err("invalid plane identity certificate");
        }
        let original=floats::<6>(c,68)?;
        if original.iter().zip(plane).any(|(a,b)|a.to_bits()!=b.to_bits()) {
            return Err("plane coefficient identity mismatch");
        }
        let method=u(4); let faces=u(56); let edges=u(60); let coefficients=u(64);
        if method>15 || faces>100000 || edges>100000 || coefficients>1000000 ||
            (method&4!=0)!=(count>0) || count>faces as usize {
            return Err("invalid plane domain budget/method");
        }
        let basis=floats::<9>(c,116)?;
        validate_basis(&basis,&plane,side,mode)?;
        let domain=floats::<6>(c,188)?; let cutter=floats::<6>(c,236)?;
        let clearance=floats::<1>(c,284)?[0];
        if method==0 {
            if u(12)!=1 || faces!=0 || edges!=0 || coefficients!=0 ||
                domain.iter().chain(&cutter).any(|v| *v!=0.) || clearance!=0. {
                return Err("invalid canonical empty plane domain");
            }
        } else if faces==0 || edges==0 || coefficients==0 || clearance<=0. ||
            !(0..3).all(|i|domain[i]<domain[i+3] && cutter[i]<cutter[i+3]) ||
            cutter[2]!=0. {
            return Err("invalid finite plane domain/cutter");
        }
        let mut cylinders=Vec::with_capacity(count);
        for i in 0..count {
            let offset=296+136*i;
            let source_face=u(offset);
            if source_face>=faces || u(offset+4)>1 || u(offset+8)>1 || u(offset+12)!=0 ||
                cylinders.iter().any(|v: &CylinderDomain|v.source_face==source_face) {
                return Err("invalid cylinder conversion identity");
            }
            let origin=floats::<3>(c,offset+16)?; let basis=floats::<9>(c,offset+40)?;
            let radius=floats::<1>(c,offset+112)?[0]; let step_v=floats::<2>(c,offset+120)?;
            if radius<=0. || step_v[0]>=step_v[1] { return Err("invalid cylinder finite domain"); }
            cylinders.push(CylinderDomain {source_face,swap_uv:u(offset+4)==1,inside_out:u(offset+8)==1,
                origin,basis,radius,step_v});
        }
        let rectangles=source::decode(&bytes[base..],version,method,faces,edges,coefficients,&cylinders)?;
        Ok(Self { version,rectangles,input,output,method,faces,edges,coefficients,basis,domain,cutter,clearance,cylinders,
            outcome:if u(12)==1 {NumericalOutcome::Empty} else {NumericalOutcome::NonEmpty} })
    }
}
pub(crate) fn validate_plane(plane: &[f64;6]) -> Result<(), &'static str> {
    if !plane.iter().all(|v|v.is_finite()) || plane[3..].iter().all(|v|*v==0.) {
        return Err("expected finite local metre plane with nonzero normal");
    }
    Ok(())
}
fn floats<const N: usize>(bytes: &[u8], offset: usize) -> Result<[f64;N], &'static str> {
    let values=std::array::from_fn(|i|f64::from_le_bytes(
        bytes[offset+8*i..offset+8*i+8].try_into().expect("eight bytes")));
    if values.iter().all(|v|v.is_finite()) { Ok(values) } else { Err("nonfinite plane certificate") }
}
fn validate_basis(b: &[f64;9], plane: &[f64;6], side: PlaneSide, mode: PlaneClipMode) -> Result<(), &'static str> {
    let scale=plane[3..].iter().map(|v|v.abs()).fold(0.,f64::max);
    let n=[plane[3]/scale,plane[4]/scale,plane[5]/scale];
    let length=n[0].hypot(n[1]).hypot(n[2]);
    let kept=side.code() as f64 * if mode==PlaneClipMode::Difference {-1.} else {1.};
    let epsilon=64.*f64::EPSILON;
    let normal=(0..3).all(|i|(b[6+i]-kept*n[i]/length).abs()<=epsilon);
    let orthogonal=(0..3).all(|i|(0..3).all(|j| {
        let dot:f64=(0..3).map(|k|b[3*i+k]*b[3*j+k]).sum();
        (dot-if i==j {1.} else {0.}).abs()<=epsilon
    }));
    let cross=[b[1]*b[5]-b[2]*b[4],b[2]*b[3]-b[0]*b[5],b[0]*b[4]-b[1]*b[3]];
    if normal && orthogonal && (0..3).all(|i|(cross[i]-b[6+i]).abs()<=epsilon) { Ok(()) }
    else { Err("invalid effective plane basis") }
}
#[cfg(test)]
#[path="plane_tests.rs"]
mod tests;
