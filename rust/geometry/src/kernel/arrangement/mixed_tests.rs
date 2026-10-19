// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use crate::kernel::{budget, Lpi};
#[path = "mixed_actual_fixture.rs"]
mod actual;
fn e(p:[f64;3])->ImplicitPoint { ImplicitPoint::Explicit(p) }
fn host()->Tri { [[0.,0.,0.],[4.,0.,0.],[0.,4.,0.]] }
fn raw()->Tri { [[1.,-1.,-1.],[1.,5.,-1.],[1.,-1.,5.]] }
fn cop()->Tri { let d=1./65536.; [[-1.,1.,-d],[5.,1.,d],[-1.,5.,-d]] }
fn used(it:&Interner,tris:&[[Vid;3]],p:&ImplicitPoint)->bool {
    tris.iter().flatten().any(|&v|cmp_lex(it.get(v),p)==Sign::Zero)
}
fn no_straddle(it:&Interner,tris:&[[Vid;3]],plane:&Tri) {
    for tri in tris {
        let signs=tri.map(|v|crate::kernel::predicates::orient3d(it.get(v),&e(plane[0]),&e(plane[1]),&e(plane[2])));
        assert!(!(signs.contains(&Sign::Positive)&&signs.contains(&Sign::Negative)),"cell straddles an existing constraint");
    }
}
#[test]
fn issue_7292_mixed_crossing_is_used_on_both_operands() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _test_caps = budget::test_caps::scope();
    let _element=budget::enter_element();budget::begin();
    // Exercise both exact coplanarity and the existing near-coplanar lifting
    // path, through actual zero-pad discovery and the same production builder.
    for cop in [cop(),[[-1.,1.,0.],[5.,1.,0.],[-1.,5.,0.]]] {
        budget::begin();
        assert_eq!(crate::kernel::broadphase::candidate_pairs(&[host()],&[raw(),cop]),vec![(0,0),(0,1)]);
        let arr=arrange(&[host()],&[raw(),cop]);let q=e([1.,1.,0.]);
        assert!(!budget::tripped());
        assert!(used(&arr.interner,&arr.tris_a,&q),"mixed crossing must be used by the host");
        let raw_children:Vec<_>=arr.tris_b.iter().copied().filter(|t|inside(&arr.interner,*t,&raw())).collect();
        assert!(used(&arr.interner,&raw_children,&q),"mixed crossing must split the opposite raw seam too");
        assert_positive_partition(&arr.interner,&raw_children,&raw());
        no_straddle(&arr.interner,&arr.tris_a,&raw());
        no_straddle(&arr.interner,&arr.tris_a,&[[0.,1.,0.],[1.,1.,0.],[0.,1.,1.]]);
        // Exact projected area guards against vacuously deleting crossing cells.
        let area=arr.tris_a.iter().map(|t|{
            let p=t.map(|v|crate::kernel::rational::point_of(arr.interner.get(v)));
            (&p[1][0]-&p[0][0])*(&p[2][1]-&p[0][1])-(&p[1][1]-&p[0][1])*(&p[2][0]-&p[0][0])
        }).sum::<num_rational::BigRational>();
        assert_eq!(area,num_rational::BigRational::from_integer(16.into()));
    }

}
#[test]
fn issue_7292_mixed_crossing_components_and_nary_share_builder() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _test_caps = budget::test_caps::scope();
    let _element=budget::enter_element();budget::begin();
    let a=[host()];let b=[raw()];let c=[cop()];let q=e([1.,1.,0.]);
    let arr=binary::arrange_components(&a,&[&b,&c]);
    assert!(used(&arr.interner,&arr.tris_a,&q)&&used(&arr.interner,&arr.tris_b,&q));
    let arr=arrange_many(&[&a,&b,&c]);assert!(!budget::tripped());
    assert!(used(&arr.interner,&arr.subtris[0],&q)&&used(&arr.interner,&arr.subtris[1],&q));
}
fn clip(a:[f64;3],b:[f64;3],support:Tri)->SupportedClip { SupportedClip {a:e(a),b:e(b),support} }
#[test]
fn issue_7292_coplanar_constraints_split_each_other_on_original_supports() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _test_caps = budget::test_caps::scope();
    let _element=budget::enter_element();budget::begin();
    let c=vec![clip([1.,0.,0.],[1.,3.,0.],raw()),
        clip([0.,1.,0.],[3.,1.,0.],[[0.,1.,0.],[1.,1.,0.],[0.,1.,1.]])];
    let mut points=Vec::new();let built=build(&[host()],&[vec![]],&[c],&mut points,true);
    assert!(!budget::tripped());assert_eq!(built.constraints[0].len(),4);
    assert!(points.iter().any(|p|cmp_lex(p,&e([1.,1.,0.]))==Sign::Zero));
}
#[test]
fn issue_7292_off_carrier_or_undefined_support_cannot_create_projected_tpi() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _test_caps = budget::test_caps::scope();
    let _element=budget::enter_element();budget::begin();
    let invalid=RawSeg {a:e([1.,0.,1.]),b:e([1.,3.,1.]),cutter:raw()};
    let mut points=Vec::new();let c=vec![clip([0.,1.,0.],[3.,1.,0.],[[0.,1.,0.],[1.,1.,0.],[0.,1.,1.]])];
    let _built=build(&[host()],&[vec![invalid]],&[c],&mut points,true);
    assert!(points.is_empty(),"projected crossing must not fabricate a 3D triple point");
    let bad=ImplicitPoint::Lpi(Lpi{p:[0.,0.,1.],q:[1.,0.,1.],r:host()[0],s:host()[1],t:host()[2]});
    let s=Supported{constraint:Constraint{a:bad,b:e([0.,1.,0.])},support:raw()};
    assert!(!validate(&host(),&[s])[0].valid,"parallel LPI denominator must be rejected before predicates");
    assert!(!budget::tripped());
}
#[test]
fn issue_7292_raw_only_keeps_legacy_queries_and_constraints() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _test_caps = budget::test_caps::scope();
    let _element=budget::enter_element();budget::begin();
    let r=RawSeg{a:e([1.,0.,0.]),b:e([1.,3.,0.]),cutter:raw()};
    let before=budget::snapshot_counters();let mut points=Vec::new();
    let mut built=build(&[host()],&[vec![r]],&[vec![]],&mut points,false);
    propagate(&[host()],&mut built,&points,&mut[vec![]]);
    assert_eq!(budget::snapshot_counters(),before);
    assert_eq!(built.constraints[0].len(),1);assert!(points.is_empty());
}
#[test]
fn issue_7292_global_raw_only_consumes_the_same_exact_split_stream_and_budget_work() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _test_caps = budget::test_caps::scope();
    let _element=budget::enter_element();budget::begin();
    let raws=vec![vec![RawSeg{a:e([1.,0.,0.]),b:e([1.,3.,0.]),cutter:raw()},
        RawSeg{a:e([0.,1.,0.]),b:e([3.,1.,0.]),
            cutter:[[0.,1.,0.],[1.,1.,0.],[0.,1.,1.]]}]];
    let before=budget::snapshot_counters();let mut generated=Vec::new();
    let retained=build(&[host()],&raws,&[vec![]],&mut generated,true);
    let work=budget::snapshot_counters();assert!(!budget::tripped());
    // Reuse the exact same raw input: support retention must change neither
    // raw/raw crossings nor their predicate sequence, including budget counts.
    budget::restore_counters(before);
    let consumed=build(&[host()],&raws,&[vec![]],&mut generated,false);
    assert_eq!(budget::snapshot_counters(),work);assert!(generated.is_empty());
    let expected=[([1.,0.,0.],[1.,1.,0.]),([1.,1.,0.],[1.,3.,0.]),
        ([0.,1.,0.],[1.,1.,0.]),([1.,1.,0.],[3.,1.,0.])];
    assert_eq!(consumed.constraints[0].len(),expected.len());
    assert_eq!(retained.constraints[0].len(),expected.len());
    for ((a,b),(start,end)) in consumed.constraints[0].iter().zip(&retained.constraints[0]).zip(expected) {
        assert_eq!(cmp_lex(&a.a,&b.a),Sign::Zero);assert_eq!(cmp_lex(&a.b,&b.b),Sign::Zero);
        assert_eq!(cmp_lex(&a.a,&e(start)),Sign::Zero);assert_eq!(cmp_lex(&a.b,&e(end)),Sign::Zero);
    }
}
#[test]
fn issue_7292_global_coplanar_on_another_carrier_keeps_raw_seam_propagation() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _test_caps = budget::test_caps::scope();
    let _element=budget::enter_element();budget::begin();
    let mut generated=Vec::new();
    let raw_seam=RawSeg{a:e([1.,0.,0.]),b:e([1.,3.,0.]),cutter:raw()};
    // The raw-only carrier is built FIRST; only a later carrier generates q.
    let mut raw_built=build(&[host()],&[vec![raw_seam]],&[vec![]],&mut generated,true);
    assert!(generated.is_empty());
    let clips=vec![clip([1.,0.,0.],[1.,3.,0.],raw()),
        clip([0.,1.,0.],[3.,1.,0.],[[0.,1.,0.],[1.,1.,0.],[0.,1.,1.]])];
    let _other=build(&[host()],&[vec![]],&[clips],&mut generated,true);
    assert_eq!(generated.len(),1);
    let mut points=vec![vec![]];propagate(&[host()],&mut raw_built,&generated,&mut points);
    assert!(!budget::tripped());assert_eq!(points[0].len(),1);
    assert_eq!(cmp_lex(&points[0][0],&e([1.,1.,0.])),Sign::Zero);
}
#[test]
fn issue_7292_new_work_budget_trip_discards_partial_arrangement_without_panic() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _test_caps = budget::test_caps::scope();
    struct Reset(Option<u64>);impl Drop for Reset{fn drop(&mut self){budget::test_caps::set_cap(self.0);budget::begin();}}
    let _reset=Reset(budget::cap());let _element=budget::enter_element();
    budget::test_caps::set_cap(Some(1));budget::begin();budget::note_escalation();
    let before=budget::snapshot_counters();let _arr=arrange(&[host()],&[raw(),cop()]);
    assert!(budget::tripped());assert_eq!(before,budget::snapshot_counters());
    budget::begin();let _arr=arrange(&[host()],&[raw(),cop()]);assert!(budget::tripped());
}
fn inside(it:&Interner,tri:[Vid;3],parent:&Tri)->bool {
    let (axis,w)=projection_axis(parent).unwrap();
    tri.iter().all(|&v|on_plane(it.get(v),parent)&&(0..3).all(|i|
        orient2d_any(&e(parent[i]),&e(parent[(i+1)%3]),it.get(v),axis)!=w.flip()))
}
fn assert_positive_partition(it:&Interner,children:&[[Vid;3]],parent:&Tri) {
    let (axis,w)=projection_axis(parent).unwrap();
    let indices=match axis {crate::kernel::DropAxis::X=>(1,2),crate::kernel::DropAxis::Y=>(0,2),crate::kernel::DropAxis::Z=>(0,1)};
    let area=|p:[[num_rational::BigRational;3];3]| {
        let (u,v)=indices;
        (&p[1][u]-&p[0][u])*(&p[2][v]-&p[0][v])-(&p[1][v]-&p[0][v])*(&p[2][u]-&p[0][u])
    };
    assert!(!children.is_empty());
    for t in children {
        assert_eq!(orient2d_any(it.get(t[0]),it.get(t[1]),it.get(t[2]),axis),w,
            "source carrier children must have nonzero original winding");
    }
    let total=children.iter().map(|t|area(t.map(|v|crate::kernel::rational::point_of(it.get(v)))))
        .sum::<num_rational::BigRational>();
    let original=area(parent.map(|p|crate::kernel::rational::point_of(&e(p))));
    assert_eq!(total,original,"finite original carrier must remain fully partitioned");
}
#[test]
fn issue_7292_actual794_mixed_crossing_conforms_both_original_carriers() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _test_caps = budget::test_caps::scope();
    let _element=budget::enter_element();budget::begin();
    let (a,b)=actual::operands();
    let aux=[[8192009./65536.,176491./16384.,-3741087./32768.],
        [7648839./65536.,12692043./16384.,13785881./32768.],
        [8192009./65536.,176491./16384.,-3708319./32768.]];
    let q=ImplicitPoint::Tpi(Tpi{planes:[b[65],a[0],aux]});
    let arr=arrange(&a,&b);assert!(!budget::tripped());
    let ac:Vec<_>=arr.tris_a.iter().copied().filter(|t|inside(&arr.interner,*t,&a[0])).collect();
    let bc:Vec<_>=arr.tris_b.iter().copied().filter(|t|inside(&arr.interner,*t,&b[65])).collect();
    assert!(used(&arr.interner,&ac,&q),"actual mixed q must split A0's original raw seam");
    assert!(used(&arr.interner,&bc,&q),"actual mixed q must split B65's raw/cop crossing");
    assert_positive_partition(&arr.interner,&ac,&a[0]);
    assert_positive_partition(&arr.interner,&bc,&b[65]);
    no_straddle(&arr.interner,&bc,&a[0]);
    // The auxiliary plane is only a finite cop edge constraint: do not demand
    // that its infinite extension partition unrelated A0 regions.
}

// Independent uncullled traversal retained only as a behavioral/work oracle for
// propagation. It uses the original support and containment predicates.
fn propagate_unculled(tris: &[Tri], built: &Built, generated: &[ImplicitPoint]) -> Vec<Vec<ImplicitPoint>> {
    let mut generated = generated.to_vec();
    assert!(canonical(&mut generated));
    let mut points = vec![Vec::new(); tris.len()];
    for (i,t) in tris.iter().enumerate() {
        let valid = validate(t, &built.segments[i]);
        let Some((axis,_)) = projection_axis(t) else { continue; };
        for p in &generated {
            assert!(charge());
            if !on_plane(p,t) { continue; }
            let lam = interval::ilambda_cached(p);
            for (s,original) in valid.iter().zip(&built.segments[i]).filter(|(s,_)| s.valid) {
                assert!(charge());
                let c = &original.constraint;
                if orient2d_end((&s.lambda.0,&c.a),(&s.lambda.1,&c.b),(&lam,p),axis) == Sign::Zero {
                    let (a,b) = if order(&c.a,&c.b) == Ordering::Greater { (&c.b,&c.a) } else { (&c.a,&c.b) };
                    if order(a,p) != Ordering::Greater && order(p,b) != Ordering::Greater {
                        points[i].push(p.clone()); break;
                    }
                }
            }
        }
        if !points[i].is_empty() { assert!(canonical(&mut points[i])); }
    }
    points
}

#[test]
fn issue_7292_raw_only_propagation_culls_seams_before_support_work_with_identical_points() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _test_caps = budget::test_caps::scope();
    struct Reset(Option<u64>,Option<u64>);
    impl Drop for Reset { fn drop(&mut self) {
        budget::test_caps::set_cap(self.0); budget::test_caps::set_element_cap(self.1); budget::begin();
    }}
    let _reset=Reset(budget::cap(),budget::element_cap());
    budget::test_caps::set_cap(None);
    let tris=vec![[[0.,0.,0.],[2000.,0.,0.],[0.,2000.,0.]];256];
    // Every carrier AABB contains every generated point, but the actual seams
    // are separated. No carrier-box shortcut can establish the saving.
    let raw:Vec<_>=(0..256).map(|i| {
        let x=f64::from(i)*3.;
        vec![RawSeg {a:e([x,1.,0.]),b:e([x+1.,1.,0.]),
            cutter:[[0.,1.,0.],[1.,1.,0.],[0.,1.,1.]]}]
    }).collect();
    let generated:Vec<_>=(0..256).rev().flat_map(|i| {
        let x=f64::from(i)*3.;
        [e([x+1.,1.,0.]),e([x+0.5,1.,0.]),e([x,1.,0.]),e([x+0.5,1.,0.])]
    }).collect();
    let cop:Vec<_>=(0..tris.len()).map(|_|Vec::new()).collect();
    let expected;
    {
        let _element=budget::enter_element(); budget::begin();
        let built=build(&tris,&raw,&cop,&mut Vec::new(),true);
        expected=propagate_unculled(&tris,&built,&generated);
        assert!(budget::element_count()>budget::DEFAULT_ELEMENT_CAP,
            "the uncullled reference must actually exceed the interactive work allowance");
    }
    budget::test_caps::set_cap(Some(budget::DEFAULT_CAP));
    budget::test_caps::set_element_cap(Some(budget::DEFAULT_ELEMENT_CAP));
    let _element=budget::enter_element(); budget::begin();
    let mut built=build(&tris,&raw,&cop,&mut Vec::new(),true);
    let mut actual=vec![Vec::new();tris.len()];
    propagate(&tris,&mut built,&generated,&mut actual);
    assert!(!budget::tripped());
    assert!(budget::element_count()<budget::DEFAULT_ELEMENT_CAP/10,
        "disjoint seam pairs must be culled before charge/plane/support work");
    for (i,(actual,expected)) in actual.iter().zip(&expected).enumerate() {
        assert_eq!(actual.len(),3); assert_eq!(actual.len(),expected.len());
        for (a,b) in actual.iter().zip(expected) { assert_eq!(cmp_lex(a,b),Sign::Zero); }
        for (p,dx) in actual.iter().zip([0.,0.5,1.]) {
            assert_eq!(cmp_lex(p,&e([i as f64*3.+dx,1.,0.])),Sign::Zero);
        }
    }
}

#[test]
fn issue_7292_propagation_keeps_exact_support_checks_and_seams_beyond_carrier_bounds() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _test_caps = budget::test_caps::scope();
    let _element=budget::enter_element(); budget::begin();
    let horizontal=[[0.,1.,0.],[1.,1.,0.],[0.,1.,1.]];
    let undefined=ImplicitPoint::Lpi(Lpi {p:[0.,0.,1.],q:[1.,0.,1.],
        r:host()[0],s:host()[1],t:host()[2]});
    let supported=|a,b,support|Supported{constraint:Constraint{a,b},support};
    let mut built=Built { constraints:vec![vec![]], validated:vec![None], segments:vec![vec![
        supported(e([10.,1.,0.]),e([12.,1.,0.]),horizontal),
        supported(e([1.,1.,0.]),e([3.,1.,0.]),[[0.;3];3]),
        supported(e([1.,2.,0.]),e([3.,2.,0.]),horizontal),
        supported(undefined,e([2.,3.,0.]),raw()),
        supported(e([1.,3.,1.]),e([2.,3.,1.]),raw()),
    ]]};
    let generated=vec![e([12.,1.,0.]),e([11.,1.,0.]),e([10.,1.,0.]),e([13.,1.,0.]),
        e([2.,1.,0.]),e([2.,2.,0.]),e([2.,3.,0.]),e([1.5,3.,1.])];
    let expected=propagate_unculled(&[host()],&built,&generated);
    let mut actual=vec![vec![]];propagate(&[host()],&mut built,&generated,&mut actual);
    assert!(!budget::tripped());assert_eq!(actual[0].len(),3);
    assert_eq!(actual[0].len(),expected[0].len());
    for (a,b) in actual[0].iter().zip(&expected[0]) {assert_eq!(cmp_lex(a,b),Sign::Zero);}
    for (p,x) in actual[0].iter().zip([10.,11.,12.]) {assert_eq!(cmp_lex(p,&e([x,1.,0.])),Sign::Zero);}
}

#[test]
fn issue_7292_uncertain_finite_implicit_seam_uses_exact_support_and_containment() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _test_caps = budget::test_caps::scope();
    let _element=budget::enter_element(); budget::begin();
    let carrier=[[0.,0.,0.],[4.,0.,4.],[0.,4.,0.]];
    let endpoint=ImplicitPoint::Lpi(Lpi {p:[0.,0.,1.],q:[1.,0.,2.+2.*f64::EPSILON],
        r:carrier[0],s:carrier[1],t:carrier[2]});
    assert!(interval::ilambda_cached(&endpoint).1.sign().is_none(),
        "control must require exact resolution rather than a definite interval box");
    let x=-1./(2.*f64::EPSILON);
    let seam=RawSeg {a:endpoint,b:e([x+2.,0.,x+2.]),
        cutter:[[0.,0.,0.],[1.,0.,0.],[0.,0.,1.]]};
    let mut built=build(&[carrier],&[vec![seam]],&[vec![]],&mut Vec::new(),true);
    let generated=vec![e([x+1.,0.,x+1.]),e([x+3.,0.,x+3.])];
    let expected=propagate_unculled(&[carrier],&built,&generated);
    let mut actual=vec![vec![]];propagate(&[carrier],&mut built,&generated,&mut actual);
    assert!(!budget::tripped());assert_eq!(actual[0].len(),1);
    assert_eq!(expected[0].len(),1);assert_eq!(cmp_lex(&actual[0][0],&expected[0][0]),Sign::Zero);
    assert_eq!(cmp_lex(&actual[0][0],&e([x+1.,0.,x+1.])),Sign::Zero);
}
