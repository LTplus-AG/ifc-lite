// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
fn tetra() -> Vec<Tri> {
    let (a,b,c,d)=([0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]);
    vec![[a,c,b],[a,b,d],[a,d,c],[b,c,d]]
}
// #7292/#5635: an open source is not a solid for newly introduced opposite
// ownership. A real closed tetra remains eligible; delete or flip a face and
// the certificate must decline, without changing any near-band tolerance.
#[test]
fn opposed_source_requires_actual_closed_oriented_surface_7292() {
    let _lock=crate::kernel::budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _element=crate::kernel::budget::enter_element();crate::kernel::budget::begin();
    let closed=tetra();assert!(strict_closed(&closed));
    assert!(!strict_closed(&closed[..3]));
    let mut flipped=closed.clone();flipped[0].swap(1,2);assert!(!strict_closed(&flipped));
    let mut duplicate=closed.clone();duplicate.push(closed[0]);assert!(!strict_closed(&duplicate));
}
#[test]
fn opposed_closed_source_uses_numeric_zero_and_rejects_invalid_faces_7292() {
    let _lock=crate::kernel::budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _element=crate::kernel::budget::enter_element();crate::kernel::budget::begin();
    let mut closed=tetra();closed[0][0][0] = -0.;assert!(strict_closed(&closed));
    let mut invalid=closed.clone();invalid.push([[2.,2.,2.],[3.,3.,3.],[4.,4.,4.]]);assert!(!strict_closed(&invalid));
    invalid=closed;invalid[0][0][0]=f64::INFINITY;assert!(!strict_closed(&invalid));
}
#[test]
fn opposed_closed_source_declines_unsplit_tjunction_7292() {
    let _lock=crate::kernel::budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _element=crate::kernel::budget::enter_element();crate::kernel::budget::begin();
    let mut t=tetra();let face=t.remove(0);let p=[0.5,0.,0.];
    // Replace a real face by its two exact pieces, leaving its neighbor unsplit.
    t.push([face[0],face[1],p]);t.push([face[1],face[2],p]);
    assert!(!strict_closed(&t));
}

#[test]
fn opposed_volume_requires_every_queried_component_closed_7292() {
    use crate::kernel::{arrangement::{box_mesh,difference_all_lenient_with_conformity},ImplicitPoint,predicates::orient3d,Sign};
    let _lock=crate::kernel::budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _element=crate::kernel::budget::enter_element();crate::kernel::budget::begin();
    let a=box_mesh([0.,0.,0.],[1.,1.,1.]);let gap=1./65536.;
    let b=box_mesh([-1.,0.25,0.25],[gap,0.75,0.75]);
    let open=[[[100.,100.,100.],[101.,100.,100.],[100.,101.,100.]]];
    let covers=|tris:&[Tri],p:[f64;3]|tris.iter().any(|t| {
        let e=ImplicitPoint::Explicit;
        orient3d(&e(p),&e(t[0]),&e(t[1]),&e(t[2]))==Sign::Zero
            && crate::kernel::coplanar::contains_projected_point(t,p)
    });
    assert!(strict_closed(&a)&&strict_closed(&b));assert!(!strict_closed(&open));
    let (solid,_,conforming)=difference_all_lenient_with_conformity(&a,&[&b]);
    assert!(conforming&&!crate::kernel::budget::tripped());
    assert!(!covers(&solid,[0.,0.5,0.5]),"two closed sources admit the new real-overlap A removal");
    assert!(covers(&solid,[gap,0.5,0.5]),"two closed sources retain the opposite B recess cap");
    crate::kernel::budget::begin();
    let (uncertified,_,conforming)=difference_all_lenient_with_conformity(&a,&[&b,&open]);
    assert!(conforming&&!crate::kernel::budget::tripped(),"conformity describes constraints, not solidness of an open component");
    // The remote component cannot geometrically reach A or the selected near
    // cap, but the union parity API may query it. It invalidates the NEW solid
    // ownership precondition consistently in BOTH directions. Historical
    // ordinary rays and shared-copy policy remain available; no closed-output
    // or physical-volume claim is made for this deliberately open operand.
    assert!(covers(&uncertified,[0.,0.5,0.5]),"open union declines the new A-side volume decision");
    assert!(!covers(&uncertified,[gap,0.5,0.5]),"open union also declines the new B-side volume decision");
    assert!(covers(&solid,[1.,0.5,0.5])&&covers(&uncertified,[1.,0.5,0.5]),"ordinary far host face stays present");
    assert!(uncertified.iter().flatten().all(|p|p.iter().all(|v|v.abs()<2.)),"the unrelated open triangle itself is not retained");
}
