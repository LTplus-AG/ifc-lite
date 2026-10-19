// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Direct candidate-build coverage for lazy support validation (#7292).
use super::*;
use crate::kernel::Lpi;
use num_traits::Zero;

fn e(p: [f64; 3]) -> ImplicitPoint { ImplicitPoint::Explicit(p) }
fn carrier() -> Tri { [[0.,0.,0.],[4.,0.,4.],[0.,4.,0.]] }
fn horizontal() -> Tri { [[0.,0.,0.],[1.,0.,0.],[0.,0.,1.]] }
fn vertical(x: f64) -> Tri { [[x,0.,0.],[x,1.,0.],[x,0.,1.]] }
fn uncertain_endpoint() -> ImplicitPoint {
    let t=carrier();
    ImplicitPoint::Lpi(Lpi {p:[0.,0.,1.],q:[1.,0.,2.+2.*f64::EPSILON],
        r:t[0],s:t[1],t:t[2]})
}
fn crossing_clip(x: f64) -> SupportedClip {
    SupportedClip {a:e([x,-1.,x]),b:e([x,1.,x]),support:vertical(x)}
}
fn supported(clips: &[SupportedClip]) -> Vec<Supported> {
    clips.iter().map(|c| Supported {constraint:Constraint {a:c.a.clone(),b:c.b.clone()},
        support:c.support}).collect()
}

// Eager all-pairs oracle: no spatial candidate filtering, no lazy cache. Literal
// expected coordinates below separately establish the geometric intersections.
fn unculled_crossings(t: &Tri, segments: &[Supported], raw_count: usize) -> Vec<ImplicitPoint> {
    let valid=validate(t,segments);
    assert_eq!(valid.len(),segments.len());assert!(!budget::tripped());
    let axis=projection_axis(t).expect("nondegenerate carrier").0;
    let mut generated=Vec::new();
    for k in 0..segments.len() {
        for l in k+1..segments.len() {
            if k<raw_count && l<raw_count { continue; }
            assert!(charge());
            let a=&valid[k];let b=&valid[l];
            if !a.valid || !b.valid { continue; }
            let ca=&segments[k].constraint;let cb=&segments[l].constraint;
            if segments_cross((&a.lambda.0,&ca.a),(&a.lambda.1,&ca.b),
                (&b.lambda.0,&cb.a),(&b.lambda.1,&cb.b),axis) {
                generated.push(ImplicitPoint::Tpi(Tpi {planes:[*t,segments[k].support,segments[l].support]}));
            }
        }
    }
    assert!(!budget::tripped());generated
}

#[test]
fn issue_7292_lazy_build_uncertain_defined_lpi_matches_unculled_crossing_order() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _test_caps = budget::test_caps::scope();
    let _element=budget::enter_element();budget::begin();
    let t=carrier();let endpoint=uncertain_endpoint();let x=-1./(2.*f64::EPSILON);
    assert!(interval::ilambda_cached(&endpoint).1.sign().is_none());
    assert!(!crate::kernel::rational::lambda_of(&endpoint).1.is_zero());
    let raw=RawSeg {a:endpoint,b:e([x+4.,0.,x+4.]),cutter:horizontal()};
    let clips=vec![crossing_clip(x+1.),crossing_clip(x+3.)];
    let mut generated=Vec::new();
    let result=build(&[t],&[vec![raw]],&[clips],&mut generated,true);
    assert!(!budget::tripped());
    let reference=unculled_crossings(&t,&result.segments[0],1);
    assert_eq!(generated.len(),2);assert_eq!(generated.len(),reference.len());
    assert_eq!(result.constraints[0].len(),7,"all three crossing seams must split");
    for ((actual,expected),dx) in generated.iter().zip(&reference).zip([1.,3.]) {
        assert_eq!(cmp_lex(actual,expected),Sign::Zero,"original pair enumeration order");
        assert_eq!(cmp_lex(actual,&e([x+dx,0.,x+dx])),Sign::Zero);
    }
}

#[test]
fn issue_7292_lazy_build_unknown_invalid_candidates_never_fabricate_a_tpi() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _test_caps = budget::test_caps::scope();
    let _element=budget::enter_element();budget::begin();
    let t=carrier();let x=-1./(2.*f64::EPSILON);let endpoint=uncertain_endpoint();
    let undefined=ImplicitPoint::Lpi(Lpi {p:[0.,0.,1.],q:[1.,0.,2.],r:t[0],s:t[1],t:t[2]});
    assert!(crate::kernel::rational::lambda_of(&undefined).1.is_zero());
    let mut nan_support=horizontal();nan_support[0][0]=f64::NAN;
    let mut inf_support=horizontal();inf_support[0][0]=f64::INFINITY;
    let end=e([x+2.,0.,x+2.]);
    let cases=[
        ("undefined denominator",undefined,end.clone(),horizontal()),
        ("NaN endpoint",e([f64::NAN,0.,0.]),end.clone(),horizontal()),
        ("infinite endpoint",e([f64::INFINITY,0.,0.]),end.clone(),horizontal()),
        ("NaN support",endpoint.clone(),end.clone(),nan_support),
        ("infinite support",endpoint.clone(),end.clone(),inf_support),
        ("off-support plane",endpoint.clone(),end.clone(),[[0.,1.,0.],[1.,1.,0.],[0.,1.,1.]]),
        ("degenerate support",endpoint.clone(),end,[[0.;3];3]),
        ("off-carrier endpoint",endpoint,e([x+2.,0.,x+3.]),horizontal()),
    ];
    for (name,a,b,support) in cases {
        budget::begin();
        let clips=vec![SupportedClip {a,b,support},crossing_clip(x+1.)];
        let original=supported(&clips);
        // Every invalid first segment must actually reach candidate validation:
        // an unknown interval box retains the second segment despite all cases.
        assert_eq!(broadphase::Candidates::unvalidated(&original).after(0),vec![1],"{name}");
        let before=budget::count();let mut generated=Vec::new();
        let result=build(&[t],&[vec![]],&[clips],&mut generated,true);
        assert!(!budget::tripped(),"{name}");assert!(budget::count()>before,"{name}");
        assert!(generated.is_empty(),"invalid support fabricated a TPI: {name}");
        assert_eq!(result.constraints[0].len(),2,"unsplit constraints retained: {name}");
        assert!(unculled_crossings(&t,&original,0).is_empty(),"eager reference: {name}");
    }
}

#[test]
fn issue_7292_lazy_build_budget_trip_during_candidate_validation_is_sticky() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _test_caps = budget::test_caps::scope();
    struct Reset(Option<u64>);
    impl Drop for Reset { fn drop(&mut self) {budget::test_caps::set_cap(self.0);budget::begin();} }
    let _reset=Reset(budget::cap());budget::test_caps::set_cap(Some(2));
    let _element=budget::enter_element();budget::begin();
    let t=carrier();let x=-1./(2.*f64::EPSILON);
    let clips=vec![SupportedClip {a:uncertain_endpoint(),b:e([x+2.,0.,x+2.]),support:horizontal()},
        crossing_clip(x+1.)];
    let cop=vec![clips];let mut generated=Vec::new();
    // Pair charge consumes one unit; the first lazy validate_one charge trips
    // before definedness/geometry predicates, so the failure cannot overshoot.
    let mut result=build(&[t],&[vec![]],&cop,&mut generated,true);
    assert!(budget::tripped());assert_eq!(budget::count(),2);assert!(generated.is_empty());
    let stopped=budget::snapshot_counters();
    let second=build(&[t],&[vec![]],&cop,&mut generated,true);
    let mut points=vec![vec![]];
    propagate(&[t],&mut result,&[e([x+1.,0.,x+1.])],&mut points);
    assert_eq!(budget::snapshot_counters(),stopped);
    assert!(second.constraints.is_empty());assert!(generated.is_empty());assert!(points[0].is_empty());
}
