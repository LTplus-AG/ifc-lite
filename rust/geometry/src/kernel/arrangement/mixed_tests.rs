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
    let _element=budget::enter_element();budget::begin();
    let c=vec![clip([1.,0.,0.],[1.,3.,0.],raw()),
        clip([0.,1.,0.],[3.,1.,0.],[[0.,1.,0.],[1.,1.,0.],[0.,1.,1.]])];
    let mut points=Vec::new();let built=build(&[host()],&[vec![]],&[c],&mut points);
    assert!(!budget::tripped());assert_eq!(built.constraints[0].len(),4);
    assert!(points.iter().any(|p|cmp_lex(p,&e([1.,1.,0.]))==Sign::Zero));
}
#[test]
fn issue_7292_off_carrier_or_undefined_support_cannot_create_projected_tpi() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _element=budget::enter_element();budget::begin();
    let invalid=RawSeg {a:e([1.,0.,1.]),b:e([1.,3.,1.]),cutter:raw()};
    let mut points=Vec::new();let c=vec![clip([0.,1.,0.],[3.,1.,0.],[[0.,1.,0.],[1.,1.,0.],[0.,1.,1.]])];
    let _built=build(&[host()],&[vec![invalid]],&[c],&mut points);
    assert!(points.is_empty(),"projected crossing must not fabricate a 3D triple point");
    let bad=ImplicitPoint::Lpi(Lpi{p:[0.,0.,1.],q:[1.,0.,1.],r:host()[0],s:host()[1],t:host()[2]});
    let s=Supported{constraint:Constraint{a:bad,b:e([0.,1.,0.])},support:raw()};
    assert!(!validate(&host(),&[s])[0].valid,"parallel LPI denominator must be rejected before predicates");
    assert!(!budget::tripped());
}
#[test]
fn issue_7292_raw_only_keeps_legacy_queries_and_constraints() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _element=budget::enter_element();budget::begin();
    let r=RawSeg{a:e([1.,0.,0.]),b:e([1.,3.,0.]),cutter:raw()};
    let before=budget::snapshot_counters();let mut points=Vec::new();
    let mut built=build(&[host()],&[vec![r]],&[vec![]],&mut points);
    propagate(&[host()],&mut built,&points,&mut[vec![]]);
    assert_eq!(budget::snapshot_counters(),before);
    assert_eq!(built.constraints[0].len(),1);assert!(points.is_empty());
}
#[test]
fn issue_7292_new_work_budget_trip_discards_partial_arrangement_without_panic() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    struct Reset(Option<u64>);impl Drop for Reset{fn drop(&mut self){budget::set_cap(self.0);budget::begin();}}
    let _reset=Reset(budget::cap());let _element=budget::enter_element();
    budget::set_cap(Some(1));budget::begin();budget::note_escalation();
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
