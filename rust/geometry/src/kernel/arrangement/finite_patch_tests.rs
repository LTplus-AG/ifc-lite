// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use crate::kernel::{Lpi,rational::point_of};
use num_traits::ToPrimitive;
fn normal(t: &Tri) -> [f64;3] { super::super::cross3(super::super::sub_f64(t[1],t[0]),super::super::sub_f64(t[2],t[0])) }
fn center(t: &Tri) -> [f64;3] { std::array::from_fn(|k|(t[0][k]+t[1][k]+t[2][k])/3.) }

#[test]
fn actual_29degree_source_pair_covers_whole_near_cell_7292_5635() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());let _element=budget::enter_element();budget::begin();
    // Actual first29° call B651 versus original host faces196/197. The source
    // planes differ after f32 import, but they retain their exact shared edge.
    let own=[[10.36499595569326,-0.8939971923828125,0.04000854486308749],
        [10.36500167846676,0.04356241157981411,0.000005086233918853227],
        [10.364995957330365,0.512208109241966,0.0399971011350301]];
    let others=[[[10.364990234375,0.9810028076171875,-0.0399932861328125],
        [10.365005493164062,-0.8939971923828125,-0.0399932861328125],
        [10.364990234375,-0.8939971923828125,0.040008544921875]],
        [[10.364990234375,0.9810028076171875,-0.0399932861328125],
        [10.364990234375,-0.8939971923828125,0.040008544921875],
        [10.364990234375,0.9810028076171875,0.0399932861328125]]];
    let band=NearBand::from_operands(&[own],&others);let c=center(&own);let n=normal(&own);let exact=own.map(e);
    assert!(near_shared_surface_tri(c,&own,exact.each_ref(),&others[1],&band).is_none(),"one finite triangle cannot cover this crossing cell");
    assert!(near_shared_patch(c,n,&own,exact.each_ref(),&others,1,&band,&OnceCell::new()).is_some(),"the exact finite pair must cover the entire cell");
    let mut outside=own;outside[0][1] = -1.;let p=outside.map(e);
    assert!(near_shared_patch(center(&outside),normal(&outside),&outside,p.each_ref(),&others,1,&band,&OnceCell::new()).is_none(),"finite union cannot extend beyond the real outside boundary");
    let mut nonmanifold=others.to_vec();nonmanifold.push(others[0]);
    assert!(near_shared_patch(c,n,&own,exact.each_ref(),&nonmanifold,1,&band,&OnceCell::new()).is_none(),"ambiguous source edge cannot supply a pair");
    let mut tilted=others;tilted[0][1][0]+=1.;
    assert!(near_shared_patch(c,n,&own,exact.each_ref(),&tilted,1,&band,&OnceCell::new()).is_none(),"the neighbor must independently fit the unchanged band");
    assert!(!budget::tripped());
}

#[test]
fn finite_patch_rejects_a_concave_pair_gap_7292() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());let _element=budget::enter_element();budget::begin();
    let t=[[0.,0.,0.],[2.,0.,0.],[0.,2.,0.]];
    let u=[[2.,0.,0.],[0.,0.,0.],[3.,-0.1,0.]];
    // This triangle's first corner is in the convex hull, but outside BOTH
    // real source triangles. A hull-only or vertex-union shortcut is invalid.
    let own=[[2.,0.2,0.],[1.5,0.1,0.],[1.5,0.3,0.]].map(e);
    assert!(!pair_contains(own.each_ref(),&t,&u,0,crate::kernel::DropAxis::Z));
}

#[test]
fn finite_patch_keeps_symbolic_outer_boundary_all_axes_and_windings_7292() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());let _element=budget::enter_element();budget::begin();
    for axis in 0..3 { for offset in [-1.,1.] { for reverse in [false,true] {
        let perm=|p:[f64;3]|[p[axis%3],p[(axis+1)%3],p[(axis+2)%3]];
        let gap=offset/65536.;
        let point=ImplicitPoint::Lpi(Lpi{p:perm([3.,1.,gap]),q:perm([0.,3.,gap]),
            r:perm([1.,0.,0.]),s:perm([1.,1.,0.]),t:perm([1.,0.,1.])});
        let exact=[point,e(perm([1.,-0.1,gap])),e(perm([0.5,1.,gap]))];
        let own=exact.each_ref().map(|p|point_of(p).map(|q|q.to_f64().unwrap()));
        let mut other=[[[0.,0.,0.],[3.,1.,0.],[0.,3.,0.]].map(perm),
            [[3.,1.,0.],[0.,0.,0.],[2.,-1.,0.]].map(perm)];
        if reverse { for t in &mut other { t.swap(1,2); } }
        let band=NearBand::from_operands(&[own],&other);let c=center(&own);let n=normal(&own);
        assert!(near_shared_surface_tri(c,&own,exact.each_ref(),&other[0],&band).is_none());
        assert!(near_shared_patch(c,n,&own,exact.each_ref(),&other,0,&band,&OnceCell::new()).is_some(),"the real implicit outer boundary must be retained");
        let material=own.map(e);
        assert!(near_shared_patch(c,n,&own,material.each_ref(),&other,0,&band,&OnceCell::new()).is_none(),"rounded7/3 is outside the finite quad and cannot replace its source LPI");
    }}}
    assert!(!budget::tripped());
}

#[test]
fn actual_489_pair_cannot_borrow_a_plane_outside_whole_cell_band_7292() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());let _element=budget::enter_element();budget::begin();
    // Actual A4 and promoted B10/B11. Their projected union covers A4, but
    // B10's plane exceeds the unchanged envelope at A4's lower corner.
    let own=[[95.,12000.,-325.],[95.,11945.,-320.],[95.,12000.,-320.]];
    let other=[[[95.00016784667969,11845.,-325.],[95.,11845.,-320.],[95.,12000.,-320.]],
        [[95.00016784667969,11845.,-325.],[95.,12000.,-320.],[95.,12000.,-325.]]];
    let band=NearBand::from_operands(&[own],&other);let exact=own.map(e);
    let m=normal(&other[0]);
    assert!(!whole_cell_band(&own,&other[0],m,&band),"projected coverage alone cannot admit a different plane");
    assert!(near_shared_patch(center(&own),normal(&own),&own,exact.each_ref(),&other,1,&band,&OnceCell::new()).is_none());
    let outside=[[95.,11800.,-300.],[95.,11801.,-300.],[95.,11800.,-301.]];
    assert!(outside.iter().all(|p|p[1]<11845.),"entire control lies outside EVERY actual cutter face");
    let p=outside.map(e);
    assert!((0..2).all(|i|near_shared_patch(center(&outside),normal(&outside),&outside,p.each_ref(),&other,i,&band,&OnceCell::new()).is_none()));
    assert!(!budget::tripped());
}
