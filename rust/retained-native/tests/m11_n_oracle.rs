// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
use ifc_lite_retained_native::oracle::normals::{self,Surface};
fn source(text: &[u8],id: u32) -> Vec<Surface> {
    normals::surfaces(text,&ifc_lite_processing::extract_analytic_quantity_sources(text,None),id).unwrap()
}
fn expected(surfaces: &[Surface], p: [f64;3], normal: [f64;3]) {
    assert!(surfaces.iter().any(|s| s.sample(p).is_some_and(|(n,d)|
        d < 1e-12 && normals::angle(n,normal) < 1e-12)), "no source normal {normal:?} at {p:?}");
}
#[test]
fn m11_n_7955_source_box_uses_authored_axes() {
    let surfaces = source(include_bytes!("../../../tests/fixtures/synthetic-retained/f-c-extrusion.ifc"),27);
    // Authored frame columns are x=(.36,.48,-.8), y=(.48,.64,.6), z=(.8,-.6,0).
    assert_eq!(surfaces.len(),6);
    for n in [[0.36,0.48,-0.8],[0.48,0.64,0.6],[0.8,-0.6,0.]] {
        for sign in [1.,-1.] {
            assert!(surfaces.iter().any(|s| matches!(s,Surface::Plane {normal,..}
                if normals::angle(*normal,n.map(|v|v*sign)) < 1e-12)));
        }
    }
}
#[test]
fn m11_n_7955_source_arc_has_inner_outer_radials_and_difference_reveals() {
    let surfaces = source(include_bytes!("../../../tests/fixtures/synthetic-retained/f-a-curved.ifc"),55);
    // Hand-authored annulus 10..10.6 m, height 3 m, opening x=9..12,
    // y=-.5...5, height 2 m. Difference reverses the cutter's y planes.
    expected(&surfaces,[10.6,0.,2.5],[1.,0.,0.]);
    expected(&surfaces,[10.,0.,2.5],[-1.,0.,0.]);
    expected(&surfaces,[10.3,0.5,1.],[0.,-1.,0.]);
    expected(&surfaces,[10.3,-0.5,1.],[0.,1.,0.]);
    expected(&surfaces,[10.3,0.,2.],[0.,0.,-1.]);
}
#[test]
fn m11_n_7955_source_trimmed_disk_respects_millimetres_and_mapped_directrix() {
    let surfaces = source(include_bytes!("../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc"),50);
    assert_eq!(surfaces.len(),3);
    expected(&surfaces,[1.,0.0145,0.],[0.,1.,0.]);
    expected(&surfaces,[1.,0.,-0.0145],[0.,0.,-1.]);
    expected(&surfaces,[0.,0.,0.],[-1.,0.,0.]);
    expected(&surfaces,[2.75,0.,0.],[1.,0.,0.]);
}
