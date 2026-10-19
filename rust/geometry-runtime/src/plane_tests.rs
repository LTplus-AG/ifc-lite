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
        (64,u32::MAX),(68,3),(72,100001),(76,100001),(80,1000001),(308,17),(308,u32::MAX)] {
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
fn source_packet(cylinders: bool, count: usize) -> Vec<u8> {
    let mut b=packet(cylinders); let base=b.len();
    b.resize(base+16+1376*count,0);
    put_u(&mut b,16,2); put_u(&mut b,20,if cylinders {13} else {9});
    put_u(&mut b,72,32); put_u(&mut b,80,512);
    for (i,v) in [(0,count as u32),(4,1376),(8,248)] {put_u(&mut b,base+i,v);}
    for n in 0..count {
        let r=base+16+1376*n;
        for (i,v) in [(0,1),(4,(n+1) as u32),(8,0),(12,1),(16,2),(20,1),(28,4),(32,12)] {put_u(&mut b,r+i,v);}
        for (i,values) in [(48,vec![-0.,0.,0.,-f64::MAX, 0.,1.,0.,1., 1.,0.,0.,1., 1.,1.,0.,1.]),
            (176,vec![0.,0.,1.,1.]),(208,vec![0.,0.,1.,1.]),(240,vec![0.,0.,0.,1.,1.,0.]),
            (288,vec![0.,0.,1.,1.]),(320,vec![0.,1.,-0.,1.,0.,1.,0.,1.])] {
            for (j,v) in values.into_iter().enumerate() {put_f(&mut b,r+i+8*j,v);}
        }
        for (j,(start,end)) in [(0u32,1u32),(1,3),(3,2),(2,0)].into_iter().enumerate() {
            let e=r+384+248*j;
            put_u(&mut b,e+4,start);put_u(&mut b,e+8,end);
            let a=[(start&1) as f64,(start>>1) as f64,0.];
            let z=[(end&1) as f64,(end>>1) as f64,0.];
            for (k,v) in a.into_iter().enumerate() {put_f(&mut b,e+16+8*k,v);put_f(&mut b,e+128+8*k,v);}
            for (k,v) in z.into_iter().enumerate() {put_f(&mut b,e+48+8*k,v);put_f(&mut b,e+152+8*k,v);}
            for i in [40,72,96,104,120] {put_f(&mut b,e+i,1.);}
        }
    }
    b
}
#[test]
fn frozen_source_v2_preserves_raw_bits_and_rejects_malformed_packets_before_sealing() {
    let b=source_packet(true,16); let base=448; let r=base+16;
    let c=PlaneCertificate::decode(&b,input(),PLANE,PlaneSide::Positive,PlaneClipMode::Intersection).unwrap();
    assert_eq!(c.version(),2); assert_eq!(c.source_rectangles().len(),16);
    assert_eq!(c.source_rectangles()[0].controls()[0].to_bits(),(-0f64).to_bits());
    assert_eq!(c.source_rectangles()[0].controls()[3].to_bits(),(-f64::MAX).to_bits());
    assert_eq!(c.source_rectangles()[0].edges()[0].knots(),&[0.,0.,1.,1.]);
    for (i,v) in [(16,1),(20,5),(base,0),(base,17),(base, u32::MAX),(base+4,1375),(base+8,247),(base+12,1),
        (r,2),(r+4,32),(r+4,0),(r+12,0),(r+20,2),(r+24,1),(r+28,3),(r+32,13),
        (r+36,1),(r+40,1),(r+44,1),(r+1376+4,1),(r+384,4),(r+384,2),
        (r+384+4,4),(r+384+8,2),(r+384+12,1),(r+384+248+4,0), (44,2),(60,0)] {
        let mut bad=b.clone();put_u(&mut bad,i,v);rejects(&bad);
    }
    for (i,v) in [(r+48,f64::NAN),(r+72,2.),(r+176,2.),(r+240,2.),(r+288,0.1),
        (r+336,0.),(r+384+16,f64::INFINITY),(r+384+80,2.),(r+384+112,1.),(r+384+176,1.),(r+384+128,0.5),(r+384+16,-1.)] {
        let mut bad=b.clone();put_f(&mut bad,i,v);rejects(&bad);
    }
    for len in [0,1,311,312,base,base+15,b.len()-1] {rejects(&b[..len]);}
    let mut extra=b.clone();extra.push(0);rejects(&extra);
    assert_eq!(source_packet(false,16).len(),22344);
}

#[test]
fn frozen_source_v2_maximum_payload_has_all_sixteen_cylinders_and_rectangles() {
    let source=source_packet(false,16);
    let cylinder=packet(true)[312..448].to_vec();
    let mut b=source[..312].to_vec();
    put_u(&mut b,20,13);put_u(&mut b,308,16);
    for i in 0..16 {
        let offset=b.len();b.extend_from_slice(&cylinder);
        put_u(&mut b,offset,if i==0 {0} else {16+i});
    }
    b.extend_from_slice(&source[312..]);
    assert_eq!(b.len(),crate::protocol::MAX_PLANE_PAYLOAD_BYTES);
    let c=PlaneCertificate::decode(&b,input(),PLANE,PlaneSide::Positive,PlaneClipMode::Intersection).unwrap();
    assert_eq!(c.cylinders().len(),16);assert_eq!(c.source_rectangles().len(),16);
    let mut excessive=b;excessive.push(0);rejects(&excessive);
}
#[test]
fn frozen_source_v2_boundary_preserves_both_flag_bits_and_canonical_fields() {
    let mut b=source_packet(false,1);let e=328+384;
    put_u(&mut b,e,3);put_f(&mut b,e+200,1.);put_f(&mut b,e+232,1.);put_f(&mut b,e+240,1.);
    let c=PlaneCertificate::decode(&b,input(),PLANE,PlaneSide::Positive,PlaneClipMode::Intersection).unwrap();
    let edge=&c.source_rectangles()[0].edges()[0];
    assert_eq!(edge.flags(),3);assert_eq!(edge.step(),&[0.,1.]);assert_eq!(edge.scale(),1.);
}
