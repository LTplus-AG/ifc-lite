// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use crate::kernel::{ImplicitPoint,Lpi,Tpi,budget,interval::ilambda_cached};
use num_rational::BigRational as Q;

fn q(x:f64)->Q {Q::from_float(x).expect("finite control")}
fn iv(lo:f64,hi:f64)->RnInterval {RnInterval{lo,hi}}

#[test]
fn issue_7292_quotient_boxes_enclose_exact_positive_and_negative_denominators() {
    for n in [iv(-9.,-2.),iv(-2.,3.),iv(0.,0.),iv(1./65536.,1./32768.)] {
        for d in [iv(1.,7.),iv(-7.,-1.),iv(1./65536.,1./32768.)] {
            let (lo,hi)=coordinate(n,d).expect("definite finite quotient");
            for a in [n.lo,n.hi] {for b in [d.lo,d.hi] {
                let exact=q(a)/q(b);assert!(q(lo)<=exact && exact<=q(hi));
            }}
        }
    }
    for d in [iv(-1.,1.),iv(0.,0.),iv(0.,1.),iv(-1.,0.)] {
        assert!(coordinate(iv(1.,2.),d).is_none());
    }
    assert!(coordinate(iv(f64::MAX,f64::MAX),iv(0.5,1.)).is_none());
    assert!(coordinate(iv(f64::NAN,1.),iv(1.,1.)).is_none());
    assert!(coordinate(iv(2.,1.),iv(1.,1.)).is_none());
    assert!(coordinate(iv(1.,1.),iv(2.,1.)).is_none());
    for numerator in [f64::from_bits(1),-f64::from_bits(1)] {
        let (lo,hi)=coordinate(iv(numerator,numerator),iv(2.,2.)).unwrap();
        let exact=q(numerator)/q(2.);assert!(q(lo)<=exact && exact<=q(hi));
    }
}

#[test]
fn issue_7292_box_queries_include_exact_boundary_contact_and_huge_finite_boxes() {
    let tree=Bvh::from_aabbs(&[([0.;3],[1.;3]),([1.0e308;3],[1.1e308;3])]);
    let mut hits=Vec::new();tree.query(&([1.;3],[2.;3]),&mut hits);
    assert_eq!(hits,vec![0],"closed exact AABB contact must be retained without padding");
    hits.clear();tree.query(&([1.05e308;3],[1.05e308;3]),&mut hits);assert_eq!(hits,vec![1]);
}

fn implicit(p:[f64;3],kind:usize)->ImplicitPoint {
    let [x,y,z]=p;
    match kind {
        0=>ImplicitPoint::Explicit(p),
        1=>ImplicitPoint::Lpi(Lpi {p:[x,y,z-1.],q:[x,y,z+1.],
            r:[0.,0.,z],s:[1.,0.,z],t:[0.,1.,z]}),
        _=>ImplicitPoint::Tpi(Tpi {planes:[
            [[x,0.,0.],[x,1.,0.],[x,0.,1.]],
            [[0.,y,0.],[0.,y,1.],[1.,y,0.]],
            [[0.,0.,z],[1.,0.,z],[0.,1.,z]],
        ]}),
    }
}

#[test]
fn issue_7292_candidates_retain_every_exact_crossing_for_all_point_representations() {
    let segments=[([0.,0.,0.],[4.,4.,0.]),([0.,4.,0.],[4.,0.,0.]),
        ([1.,1.,0.],[3.,3.,0.]),([4.,4.,0.],[5.,5.,0.]),
        ([8.,0.,0.],[9.,1.,0.]),([2.,-1.,0.],[2.,5.,0.])];
    let orient=|a:[f64;3],b:[f64;3],c:[f64;3]|(q(b[0])-q(a[0]))*(q(c[1])-q(a[1]))
        -(q(b[1])-q(a[1]))*(q(c[0])-q(a[0]));
    for kind in 0..3 {
        let points:Vec<_>=segments.iter().map(|&(a,b)|(implicit(a,kind),implicit(b,(kind+1)%3))).collect();
        let lambdas:Vec<_>=points.iter().map(|(a,b)|(ilambda_cached(a),ilambda_cached(b))).collect();
        let candidates=Candidates::from_lambdas(lambdas.iter().map(|(a,b)|(a,b)));
        for (i,&(a,b)) in segments.iter().enumerate() {
            let hits=candidates.after(i);assert!(hits.windows(2).all(|w|w[0]<w[1]));
            for (j,&(c,d)) in segments.iter().enumerate().skip(i+1) {
                if orient(a,b,c)*orient(a,b,d)<Q::from_integer(0.into())
                    && orient(c,d,a)*orient(c,d,b)<Q::from_integer(0.into()) {
                    assert!(hits.contains(&j),"proper crossing omitted: {kind} {i} {j}");
                }
            }
        }
        assert!(candidates.after(0).contains(&2),"collinear overlap retained");
        assert!(candidates.after(0).contains(&3),"closed endpoint contact retained");
        assert!(!candidates.after(0).contains(&4),"proven disjoint pair culled");
    }
}

#[test]
fn issue_7292_uncertain_denominator_retains_all_candidate_pairs() {
    let known=ilambda_cached(&ImplicitPoint::Explicit([0.,0.,0.]));
    let unknown=([RnInterval::point(1.);3],iv(-1.,1.));
    let far=ilambda_cached(&ImplicitPoint::Explicit([100.,100.,100.]));
    let candidates=Candidates::from_lambdas([(&known,&known),(&unknown,&unknown),(&far,&far)].into_iter());
    assert_eq!(candidates.after(0),vec![1]);assert_eq!(candidates.after(1),vec![2]);
}

#[test]
fn issue_7292_disjoint_supported_constraints_do_not_exhaust_default_element_budget() {
    use super::super::{build,SupportedClip};
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _element=budget::enter_element();budget::begin();
    let t=[[0.,0.,0.],[2000.,0.,0.],[0.,2000.,0.]];
    let clips:Vec<_>=(0..512).map(|i| {
        let x=f64::from(i)*3.;
        SupportedClip {a:ImplicitPoint::Explicit([x,1.,0.]),b:ImplicitPoint::Explicit([x+1.,1.,0.]),
            support:[[0.,1.,0.],[1.,1.,0.],[0.,1.,1.]]}
    }).collect();
    let mut generated=Vec::new();let result=build(&[t],&[vec![]],&[clips],&mut generated);
    assert!(!budget::tripped(),"spatially disjoint constraints must not spend the budget on all pairs");
    assert_eq!(result.constraints[0].len(),512);assert!(generated.is_empty());
}

#[test]
fn issue_7292_point_queries_retain_boundaries_degenerate_and_unknown_boxes_in_source_order() {
    let origin=ilambda_cached(&ImplicitPoint::Explicit([0.;3]));
    let edge=ilambda_cached(&ImplicitPoint::Explicit([1.,0.,0.]));
    let far=ilambda_cached(&ImplicitPoint::Explicit([100.;3]));
    let unknown=([RnInterval::point(1.);3],iv(-1.,1.));
    let candidates=Candidates::from_lambdas([
        (&origin,&edge),(&far,&far),(&edge,&edge),(&unknown,&unknown)
    ].into_iter());
    assert_eq!(candidates.at(&edge),vec![0,2,3],
        "closed endpoint and degenerate seam contact must survive in original order");
    assert_eq!(candidates.at(&unknown),vec![0,1,2,3]);
    assert!(candidates.bounds().is_none(),"unknown seams must make the carrier query conservative");
    let points=Candidates::from_lambdas([(&origin,&origin),(&far,&far),(&unknown,&unknown)].into_iter());
    assert_eq!(points.overlapping(candidates.bounds()),vec![0,1,2]);
    let known=Candidates::from_lambdas([(&origin,&edge),(&edge,&edge)].into_iter());
    assert_eq!(points.overlapping(known.bounds()),vec![0,2],
        "unknown generated points survive even a definite finite seam union");
}
