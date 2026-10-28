// SPDX-License-Identifier: MPL-2.0
//! #7955: host frame must be inverted before building the finite cutter.
use super::super::plane_source;
use crate::program::{inner::retained_program::RetainedProgram, retained::RetainedContract};
use nalgebra::{Matrix4, Vector4};
#[test]
fn issue_7955_survey_plane_to_host_matches_explicit_inverse_bits() {
    let text=include_str!(concat!(env!("CARGO_MANIFEST_DIR"),"/../../tests/fixtures/synthetic-retained/f-e-clips.ifc"))
        .replace("'CSG',(#85)","'SweptSolid',(#64)");
    let source=ifc_lite_core::SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder=source.decoder();let router=crate::GeometryRouter::with_units(&text,&mut decoder);
    let wall=decoder.decode_by_id(89).unwrap();
    let mut program=RetainedProgram::product_parts(&wall,RetainedContract{source_epoch:1,source_revision:1});
    while let Some(ticket)=program.request().unwrap(){
        let (reply,_)=program.admit(ticket,&router,&mut decoder).unwrap();
        program.accept(reply,&router).unwrap_or_else(|e|panic!("{:?}",e.error));
    }
    let host=program.finish().unwrap().values.pop().unwrap();
    let f=host.object_frame();
    assert!((f[0]-3f64.sqrt()/2.).abs()<1e-15 && (f[1]-0.5).abs()<1e-15);
    // Hand inverse of Rz(theta),t: [Rz(-theta),-Rz(-theta)t].
    // Use admitted frame's f64 cos/sin, so the assertion pins exact arithmetic,
    // independently of plane_source and retained_frames::relative.
    let (c,s,tx,ty)=(f[0],f[1],f[12],f[13]);
    // The retained sweep anchors its rectangle at (-2,-3), in addition to
    // the authored extrusion Position. Include that evaluation translation.
    assert!((tx-(2600000.-2.*c+3.*s)).abs()<1e-9);
    assert!((ty-(100000.-2.*s-3.*c)).abs()<1e-9);
    let inverse=Matrix4::new(c,s,0.,-c*tx-s*ty,-s,c,0.,s*tx-c*ty,0.,0.,1.,0.,0.,0.,0.,1.);
    let p=Vector4::new(2600002.5980762113,100001.5,0.,1.);
    let n=nalgebra::Vector3::new(0.8660254037844386,0.5,1.).normalize().normalize();
    let expected_p=inverse*p;let expected_r=inverse*n.push(0.);
    let halfspace=decoder.decode_by_id(70).unwrap();
    let (actual_p,actual_r)=plane_source::lower(&host,&halfspace,&mut decoder).unwrap();
    assert_eq!(actual_p.map(f64::to_bits),[expected_p.x,expected_p.y,expected_p.z].map(f64::to_bits));
    assert_eq!(actual_r.map(f64::to_bits),[expected_r.x,expected_r.y,expected_r.z].map(f64::to_bits));
    assert!((actual_p[0]-5.).abs()<1e-9 && (actual_p[1]-3.).abs()<1e-9);
    assert!((actual_r[0]-std::f64::consts::FRAC_1_SQRT_2).abs()<1e-15 && actual_r[1].abs()<1e-15);
}
