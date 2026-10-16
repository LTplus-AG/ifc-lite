// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use super::super::{clean_shapes,clean_ring,simplify_2d_collinear,weld_near_coincident_2d};
#[path="ring_guard_actual.rs"]
mod actual;
fn points(r:&[[f64;2]])->Vec<P>{r.iter().map(|p|P::new(p[0],p[1])).collect()}
fn bits(r:&[P])->Vec<[u64;2]>{r.iter().map(|p|[p.x.to_bits(),p.y.to_bits()]).collect()}
fn simple(r:&[P])->bool{
    (0..r.len()).all(|i|(i+1..r.len()).all(|j|{
        if (i+1)%r.len()==j||(j+1)%r.len()==i{return true;}
        !segments_intersect(xy(r[i]),xy(r[(i+1)%r.len()]),xy(r[j]),xy(r[(j+1)%r.len()]))
    }))
}
fn outer()->Vec<[f64;2]>{vec![[0.,0.],[1024.,-1./64.],[2048.,0.],[2048.,2048.],[0.,2048.]]}
#[test]
fn issue_7292_actual794_cleanup_cannot_create_nonincident_crossings(){
    for(input,after_weld,area,scale)in actual::rings(){
        let raw:Vec<_>=input.iter().map(|p|[f64::from_bits(p[0]),f64::from_bits(p[1])]).collect();
        let welded=weld_near_coincident_2d(&points(&raw));assert_eq!(bits(&welded),after_weld);
        assert!(simple(&welded),"actual contour is simple before collinear removal");
        let clean=clean_shapes(&[vec![raw]],f64::from_bits(area),f64::from_bits(scale));
        assert_eq!(clean.len(),1);assert!(simple(&clean[0].outer),"collinear cleanup must not create nonincident crossings");
        let keep=vec![true;welded.len()];let old=live_winding(&welded,&keep,usize::MAX);
        assert_ne!(old,0);assert_eq!(live_winding(&clean[0].outer,&vec![true;clean[0].outer.len()],usize::MAX),old);
    }
}
#[test]
fn issue_7292_guard_preserves_exact_and_harmless_forward_cleanup(){
    for b in [[1.,0.],[1.,1./65536.]]{
        let raw=vec![[0.,0.],b,[2.,0.],[2.,2.],[0.,2.]];
        let clean=clean_shapes(&[vec![raw.clone()]],4.,1.);
        assert_eq!(clean.len(),1);assert_eq!(clean[0].outer.len(),4);assert!(simple(&clean[0].outer));
        // Old direct-entry instrumentation/degenerate-ring contracts still use
        // the same sweep; this positive control must not disable all removal.
        assert_eq!(simplify_2d_collinear(&points(&raw)).len(),4);
        assert!(clean_ring(&raw,4.,1.).is_some());
    }
}
#[test]
fn issue_7292_guard_retains_whole_hole_without_chord_intersection(){
    let hole=vec![[1024.-1./512.,-1./128.],[1024.+1./512.,-1./128.],[1024.,-3./256.]];
    let a=outer();let h=points(&hole);
    assert!((0..h.len()).all(|i|!segments_intersect(a[0],a[2],xy(h[i]),xy(h[(i+1)%h.len()]))));
    assert!(!super::super::ring_is_noise(&h,4194320.,1.),"hole survives the unchanged noise gate");
    let clean=clean_shapes(&[vec![a.clone(),hole]],4194320.,1.);
    assert_eq!(clean.len(),1);assert_eq!(clean[0].holes.len(),1);
    assert_eq!(clean[0].outer,points(&a),"empty-ear check must not swallow a whole hole");
}
#[test]
fn issue_7292_guard_includes_hole_closed_contacts(){
    let holes=[
        vec![[1024.,0.],[1024.-1./64.,1./64.],[1024.+1./64.,1./64.]],
        vec![[1024.-1./64.,0.],[1024.,1./64.],[1024.+1./64.,0.]],
        vec![[1024.-1./128.,1./128.],[1024.+1./128.,1./128.],[1024.,-1./128.]],
    ];
    for hole in holes{
        let a=outer();let clean=clean_shapes(&[vec![a.clone(),hole]],4194320.,1.);
        assert_eq!(clean.len(),1);assert_eq!(clean[0].holes.len(),1);assert_eq!(clean[0].outer,points(&a));
    }
}
#[test]
fn issue_7292_guard_sees_another_outer_in_the_same_bucket(){
    let a=vec![[0.,0.],[1024.,1./64.],[2048.,0.],[2048.,2048.],[0.,2048.]];
    let island=vec![[1024.-1./512.,1./128.],[1024.+1./512.,1./128.],[1024.,3./256.]];
    let clean=clean_shapes(&[vec![a.clone()],vec![island]],4194320.,1.);
    assert_eq!(clean.len(),2);assert_eq!(clean[0].outer,points(&a),"a shortcut must not engulf another outer component");
}
#[test]
fn issue_7292_actual_stacked2_terminal_collapse_preserves_initial_triangles(){
    // Actual Single1/bucket5 overlay and post-weld coordinates from the
    // full-final-serde-identical producer dccd032f..., events118/119.
    let raw_bits=[[13818304822171359196u64,4606280819265241088u64],
        [13818304822171359196,0],[13738176088745312256,13886141365508636672],
        [13738176088745312256,0]];
    let raw=raw_bits.map(|p|p.map(f64::from_bits)).to_vec();
    let area=f64::from_bits(4646449690405655324);
    let scale=f64::from_bits(4562254508917369340);
    assert_eq!(bits(&weld_near_coincident_2d(&points(&raw))),raw_bits);
    assert!(clean_ring(&raw,area,scale).is_none(),
        "actual angular-qualified 4-to-3-to-2 collapse is legacy noise");
    let clean=clean_shapes(&[vec![raw]],area,scale);
    assert!(clean.is_empty(),
        "angular-qualified terminal contour must retain legacy noise collapse");
    // An initially positive triangle skips the angular sweep and is retained.
    let triangle=vec![[0.,0.],[2.,0.],[0.,2.]];
    let kept=clean_shapes(&[vec![triangle.clone()]],2.,1.);
    assert_eq!(kept.len(),1);assert_eq!(kept[0].outer,points(&triangle));
    assert!(chord_conflict(P::new(0.,0.),P::new(2.,0.),P::new(0.,0.),P::new(1.,0.)));
    assert!(!chord_conflict(P::new(0.,0.),P::new(2.,0.),P::new(0.,0.),P::new(0.,1.)));
}

#[test]
fn issue_7292_guard_preserves_other_region_original_footprint(){
    let a=points(&[[-1024.,0.],[0.,-1./64.],[1024.,0.],[1024.,2048.],[-1024.,2048.]]);
    let b=points(&[[-1024.,-2048.],[1024.,-2048.],[1024.,-1./128.],[0.,-1./32.],[-1024.,-1./128.]]);
    let current_a:Vec<_>=a.iter().enumerate().filter_map(|(i,&p)|(i!=1).then_some(p)).collect();
    let keep=vec![true;5];
    assert!(admissible(&a,&keep,0,1,2,5,std::iter::once(b.as_slice())));
    assert!(admissible(&b,&keep,2,3,4,5,std::iter::once(current_a.as_slice())),
        "current-only context admits B into A's removed ear");
    assert!(!admissible(&b,&keep,2,3,4,5,[current_a.as_slice(),a.as_slice()].into_iter()),
        "A's source footprint protects its original ear");
    let to_raw=|r:&[P]|r.iter().map(|p|[p.x,p.y]).collect::<Vec<_>>();
    let clean=clean_shapes(&[vec![to_raw(&a)],vec![to_raw(&b)]],4194320.,1.);
    assert_eq!(clean.len(),2);assert_eq!(clean[0].outer,current_a);
    assert_eq!(clean[1].outer,b,"later cleanup cannot cross another region's source footprint");
}
