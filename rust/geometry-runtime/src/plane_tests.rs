// SPDX-License-Identifier: MPL-2.0
//! Fault-certificate fixtures only: no SDK, domain or numerical qualification.
use super::*;
const PLANE:[f64;6]=[0.,0.,0.5,0.,0.,1.];
fn input() -> WireHandle { WireHandle {session:42,slot:1,generation:3} }
fn put_u(bytes:&mut [u8], offset:usize, value:u32) { bytes[offset..offset+4].copy_from_slice(&value.to_le_bytes()); }
fn put_f(bytes:&mut [u8], offset:usize, value:f64) { bytes[offset..offset+8].copy_from_slice(&value.to_le_bytes()); }
fn packet(cylinders:bool) -> Vec<u8> {
    let output=WireHandle {session:42,slot:2,generation:7};
    let mut b=vec![0;312+if cylinders {136} else {0}];
    b[..16].copy_from_slice(&output.to_bytes()); b[32..48].copy_from_slice(&input().to_bytes());
    b[48..64].copy_from_slice(&output.to_bytes());
    for (i,v) in [(16,1),(20,if cylinders {5} else {1}),(24,1),(64,1),(68,2),(72,6),(76,12),(80,64)] {put_u(&mut b,i,v);}
    for (i,v) in PLANE.into_iter().enumerate() {put_f(&mut b,84+i*8,v);}
    for (offset,values) in [(132,vec![1.,0.,0.,0.,1.,0.,0.,0.,1.]),
        (204,vec![-1.,-1.,0.,1.,1.,1.]),(252,vec![-2.,-2.,0.,2.,2.,2.])] {
        for (i,v) in values.into_iter().enumerate() {put_f(&mut b,offset+i*8,v);}
    }
    put_f(&mut b,300,1e-6);
    if cylinders {
        put_u(&mut b,308,1);
        for i in [0,4,8] {put_f(&mut b,352+i*8,1.);}
        put_f(&mut b,424,1.); put_f(&mut b,440,1.);
    }
    b
}
fn rejects(b:&[u8]) { assert!(PlaneCertificate::decode(b,input(),PLANE,PlaneSide::Positive,PlaneClipMode::Intersection).is_err()); }
#[test]
fn unary_plane_contract_rejects_packet_identity_drift_before_sealing() {
    // Mutate each field against a structurally decodable template. Acceptance
    // of a template is only parser coverage, never successful numerical work.
    assert!(PlaneCertificate::decode(&packet(false),input(),PLANE,PlaneSide::Positive,PlaneClipMode::Intersection).is_ok());
    for (offset,value) in [(16,2),(20,8),(24,0),(28,2),(32,43),(44,0),(48,43),(60,0),
        (64,u32::MAX),(68,3),(72,100001),(76,100001),(80,1000001),(308,17)] {
        let mut b=packet(false);put_u(&mut b,offset,value);rejects(&b);
    }
    let mut b=packet(false);put_f(&mut b,84,-0.);rejects(&b); // exact coefficient bits
    for offset in [84,132,204,252,300] {let mut b=packet(false);put_f(&mut b,offset,f64::NAN);rejects(&b);}
    for (offset,value) in [(180,-1.),(204,2.),(252,2.),(268,0.1),(300,0.)] {
        let mut b=packet(false);put_f(&mut b,offset,value);rejects(&b);
    }
    let mut b=packet(false);b.pop();rejects(&b);
    let mut b=packet(false);b.push(0);rejects(&b);
    let mut b=packet(false);let alias=input().to_bytes();b[..16].copy_from_slice(&alias);b[48..64].copy_from_slice(&alias);rejects(&b);
}
#[test]
fn unary_plane_contract_rejects_cylinder_flag_domain_and_record_drift() {
    assert!(PlaneCertificate::decode(&packet(true),input(),PLANE,PlaneSide::Positive,PlaneClipMode::Intersection).is_ok());
    for (offset,value) in [(20,1),(308,0),(312,6),(316,2),(320,2),(324,1)] {
        let mut b=packet(true);put_u(&mut b,offset,value);rejects(&b);
    }
    for (offset,value) in [(328,f64::INFINITY),(352,f64::NAN),(424,0.),(432,1.),(440,f64::NAN)] {
        let mut b=packet(true);put_f(&mut b,offset,value);rejects(&b);
    }
}
#[test]
fn unary_plane_wire_has_exact_original_coefficients_and_92_bytes() {
    use crate::protocol::{encode_request,KernelCommand};
    let plane=[-0.,1.,2.,0.,0.,f64::MAX];
    let b=encode_request(9,&KernelCommand::ClipPlane {session:42,solid:input(),plane,side:-1,mode:3}).unwrap();
    assert_eq!(b.len(),92);assert_eq!(&b[8..12],&20u32.to_le_bytes());
    assert_eq!(&b[20..36],&input().to_bytes());
    for (i,v) in plane.into_iter().enumerate() {assert_eq!(&b[36+8*i..44+8*i],&v.to_le_bytes());}
    assert_eq!(&b[84..88],&(-1i32).to_le_bytes());assert_eq!(&b[88..92],&3u32.to_le_bytes());
}
