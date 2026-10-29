// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M10: invariants independent of SDK triangulation and source text.
use ifc_lite_processing::element::retained_runtime::{bake_mesh, affine_chord_admissible, effective_radius_through_affine, NumericalLimits};
const CUBE: [f64;24] = [0.,0.,0., 1.,0.,0., 1.,1.,0., 0.,1.,0., 0.,0.,1., 1.,0.,1., 1.,1.,1., 0.,1.,1.];
const IDS: [u32;36] = [0,2,1,0,3,2, 4,5,6,4,6,7, 0,1,5,0,5,4, 1,2,6,1,6,5, 2,3,7,2,7,6, 3,0,4,3,4,7];
fn matrix(x:f64,y:f64,z:f64) -> [f64;16] { [x,0.,0.,0., 0.,y,0.,0., 0.,0.,z,0., 2.,3.,4.,1.] }
fn signed(p:&[f64], ids:&[u32]) -> f64 {
    ids.chunks_exact(3).map(|t| { let a=&p[t[0] as usize*3..]; let b=&p[t[1] as usize*3..]; let c=&p[t[2] as usize*3..];
        (a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6.
    }).sum()
}
#[test]
fn m10_mirrored_cube_keeps_positive_signed_volume() {
    let (p,i,t)=bake_mesh(matrix(-1.,1.,1.), &CUBE, &IDS);
    assert!((signed(&p,&i)-1.).abs()<1e-12);
    assert_eq!(&i[..3], &[0,1,2]); assert_eq!(t,[2.,3.,4.]);
}
#[test]
fn m10_nonuniform_volume_and_equal_keys() {
    let (p,i,_)=bake_mesh(matrix(2.,3.,4.), &CUBE, &IDS);
    assert!((signed(&p,&i)-24.).abs()<1e-12);
    let (p,_,_)=bake_mesh(matrix(2.,3.,4.), &[1.,2.,3.,1.,2.,3.], &[]);
    assert_eq!(&p[..3],&p[3..]);
}
#[test]
fn m10_chain_composition_includes_translation_once() {
    use ifc_lite_geometry::document::retained_wire::multiply;
    let a=matrix(-1.,2.,3.); let b=matrix(2.,3.,4.);
    let (mut p,i,t)=bake_mesh(b,&CUBE,&IDS);
    for p in p.chunks_exact_mut(3) { for k in 0..3 {p[k]+=t[k];} }
    let (mut sequential,_,t)=bake_mesh(a,&p,&i);
    for p in sequential.chunks_exact_mut(3) {for k in 0..3 {p[k]+=t[k];}}
    let (mut composed,_,t)=bake_mesh(multiply(a,b),&CUBE,&IDS);
    for p in composed.chunks_exact_mut(3) {for k in 0..3 {p[k]+=t[k];}}
    assert_eq!(sequential,composed);
}
#[test]
fn m10_preregistered_chord_table() {
    let limits=NumericalLimits{chord_metres:0.001, angle_degrees:5.,max_bytes:16*1024*1024};
    for (s,r,expected) in [(2.,1.,false),(1000.,0.00005,true),(3.,0.05,true),(1.,10.,true),(5150.,0.,true),(0.5,50.,true)] {
        assert_eq!(affine_chord_admissible(s,r,limits),expected,"sigma={s}, R={r}");
    }
    assert!(!affine_chord_admissible(f64::NAN,0.,limits));
    assert_eq!(effective_radius_through_affine(0.05,[1.,0.,0.,0.,1.,0.,0.,0.,3.]),0.45);
}
