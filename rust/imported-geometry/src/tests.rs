// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
#[test]
fn imported_source_survives_assembly_before_narrowing() {
    let raw=16777217.;
    let definition=ImportedDefinition{identity:ImportIdentity{store:7,revision:3,definition:4,occurrence:9},source:ImportedSource::Points(vec![raw,2.,3.]),transform_stack:vec![]};
    let ready=plan(definition);let output=execute(&ready).unwrap();let assembly=assemble(ready,output).unwrap();
    match assembly.definition.source {ImportedSource::Points(v)=>assert_eq!(v[0],raw),_=>panic!("points source")}
    match assembly.output {ImportedOutput::Points(p)=>{assert_eq!(p.positions,vec![16777216.,3.,-2.]);assert_eq!(p.min,[16777216.,3.,-2.]);},_=>panic!("points output")}
}
#[test]
fn stale_assembly_is_rejected() {
    let ready=plan(ImportedDefinition{identity:ImportIdentity::default(),source:ImportedSource::Points(vec![]),transform_stack:vec![]});
    let mut output=execute(&ready).unwrap();output.identity.revision=1;
    assert_eq!(assemble(ready,output).unwrap_err(),ImportError::IdentityMismatch);
}
#[test]
fn provided_normals_stay_perpendicular_under_shear() {
    let raw=RawMesh{points:vec![vec![0.,0.,0.],vec![1.,0.,1.],vec![0.,1.,0.]],face_vertex_indices:vec![0.,1.,2.],face_vertex_counts:None,normals:Some(vec![vec![-1.,0.,1.];3])};
    let stack=vec![vec![vec![2.,0.,0.,0.],vec![1.,3.,0.,0.],vec![0.,0.,4.,0.],vec![0.,0.,0.,1.]]];
    let output=math::mesh(&raw,&stack).unwrap();
    let n=&output.normals;
    for end in [3,6] {let dot=(0..3).map(|j|(output.positions[end+j]-output.positions[j]) as f64*n[j] as f64).sum::<f64>();assert!(dot.abs()<1e-6);}
}
#[test]
fn empty_bbox_and_signed_zero_are_preserved() {
    let p=math::points(&[],&[]).unwrap();assert_eq!(p.min,[f64::INFINITY;3]);assert_eq!(p.max,[f64::NEG_INFINITY;3]);
    let p=math::points(&[0.,0.,-0.],&[]).unwrap();assert_eq!(p.positions[1].to_bits(),(-0.0_f32).to_bits());assert_eq!(p.positions[2].to_bits(),(-0.0_f32).to_bits());
}
#[test]
fn mesh_and_points_check_every_projective_denominator() {
    let stack=vec![vec![vec![1.,0.,0.,1.],vec![0.,1.,0.,0.],vec![0.,0.,1.,0.],vec![0.,0.,0.,1.]]];
    let raw=RawMesh{points:vec![vec![0.,0.,0.],vec![-1.,0.,0.]],face_vertex_indices:vec![],face_vertex_counts:None,normals:None};
    assert_eq!(math::mesh(&raw,&stack).unwrap_err(),ImportError::HomogeneousMesh);
    // A later zero w used to place a non-finite point and poison the bbox.
    assert_eq!(math::points(&[0.,0.,0.,-1.,0.,0.],&stack).unwrap_err(),ImportError::HomogeneousPoints);
    assert!(math::points(&[0.,0.,0.,1.,0.,0.],&stack).is_ok());
}

#[test]
fn invalid_large_indices_never_wrap_into_a_real_vertex_on_wasm32() {
    let positions=vec![0.,0.,0.,1.,0.,0.,0.,1.,0.];
    let normals=compute_normals(&positions,&[0,1,0xaaaaaaab]);
    assert!(normals[..6].iter().all(|v|v.is_nan()));
    assert_eq!(&normals[6..],&[0.,0.,0.]);
}

#[test]
fn untrusted_face_counts_stay_bounded() {
    let raw = |counts: Vec<f64>| RawMesh { points: vec![vec![0., 0., 0.], vec![1., 0., 0.], vec![0., 1., 0.]], face_vertex_indices: vec![0., 1., 2.], face_vertex_counts: Some(counts), normals: None };
    assert_eq!(crate::math::mesh(&raw(vec![f64::INFINITY]), &[]).unwrap().indices, Vec::<u32>::new());
    assert_eq!(crate::math::mesh(&raw(vec![f64::NAN, 3.]), &[]).unwrap().indices, Vec::<u32>::new());
    assert_eq!(crate::math::mesh(&raw(vec![1e12]), &[]).unwrap().indices, vec![0, 1, 2]);
    assert_eq!(crate::math::mesh(&raw(vec![3.]), &[]).unwrap().indices, vec![0, 1, 2]);
}

#[test]
fn wasm32_shaped_index_boundary_is_rejected_before_wrapping() {
    // usize::MAX / 3 on a 32-bit target: the product is exactly usize::MAX.
    let boundary = 0x5555_5555_u32 as usize;
    assert_eq!(boundary.wrapping_mul(3) & 0xffff_ffff, 0xffff_ffff);
    assert_eq!(crate::math::vertex_offset(u32::MAX as usize / 3), if usize::BITS == 32 { None } else { Some(0x5555_5555 * 3) });
    // Simulated 32-bit arithmetic: checked_mul succeeds, +2 must not.
    assert_eq!(0x5555_5555_u32.checked_mul(3), Some(u32::MAX));
    assert_eq!(0x5555_5555_u32.checked_mul(3).and_then(|o| o.checked_add(2)), None);
    assert_eq!(crate::math::vertex_offset(usize::MAX / 3), None);
    let positions = vec![0., 0., 0., 1., 0., 0., 0., 1., 0.];
    let normals = compute_normals(&positions, &[0, 1, 0x5555_5555]);
    assert!(normals[..6].iter().all(|v| v.is_nan()));
    assert_eq!(&normals[6..], &[0., 0., 0.]);
}

#[test]
fn negative_and_fractional_face_counts_end_the_walk() {
    let raw = |counts: Vec<f64>| RawMesh { points: vec![vec![0., 0., 0.], vec![1., 0., 0.], vec![0., 1., 0.]], face_vertex_indices: vec![0., 1., 2.], face_vertex_counts: Some(counts), normals: None };
    let fan = |counts: Vec<f64>| crate::math::mesh(&raw(counts), &[]).unwrap().indices;
    assert_eq!(fan(vec![-1e12, 1e12]), Vec::<u32>::new());
    assert_eq!(fan(vec![2.5, 3.]), Vec::<u32>::new());
    assert_eq!(fan(vec![3., 1e12]), vec![0, 1, 2]);
    assert_eq!(fan(vec![-1., 3.]), Vec::<u32>::new());
}

#[test]
fn nan_points_pass_through_while_finite_points_check_w() {
    // Organized PCD encodes invalid returns as NaN; they must not refuse the cloud.
    let identity=vec![vec![vec![1.,0.,0.,0.],vec![0.,1.,0.,0.],vec![0.,0.,1.,0.],vec![0.,0.,0.,1.]]];
    let p=math::points(&[0.,0.,0.,f64::NAN,f64::NAN,f64::NAN,1.,2.,3.],&identity).unwrap();
    assert!(p.positions[3].is_nan());
    assert_eq!(p.max,[1.,3.,-0.]);
    let projective=vec![vec![vec![1.,0.,0.,1.],vec![0.,1.,0.,0.],vec![0.,0.,1.,0.],vec![0.,0.,0.,1.]]];
    assert_eq!(math::points(&[0.,0.,0.,-1.,0.,0.],&projective).unwrap_err(),ImportError::HomogeneousPoints);
}
