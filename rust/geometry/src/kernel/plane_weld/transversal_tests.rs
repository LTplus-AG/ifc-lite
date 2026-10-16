// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
const G:f64=1.0/65536.0;
fn actual() -> (Tri,Tri,[f64;3]) {
    ([[3729.999755859375,-7.0*G,65.0],[0.0,13.0*G,65.0],[0.0,0.0,0.0]],
     [[0.0,0.0,0.0],[3750.0,0.0,0.0],[3750.0,0.0,3900.0]],
     [3729.999755859375,0.0,65.0])
}
fn check(source:Tri,host:Tri,target:[f64;3])->bool {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    budget::begin();let band=NearBand::from_operands(&[source],&[host]);
    let face=Face::new(host,&band).unwrap();certificate(&source,target,&face,&band)
}
#[test]
fn issue_7292_original_transversal_carrier_is_orientation_and_axis_independent() {
    let(s,h,q)=actual();
    for axis in 0..3 { for reverse in [false,true] {
        let map=|p:[f64;3]|[p[axis],p[(axis+1)%3],p[(axis+2)%3]];
        let mut s=s.map(map);let mut h=h.map(map);
        if reverse {s.swap(0,1);h.swap(0,1);}
        assert!(check(s,h,map(q)));
    }}
}
#[test]
fn issue_7292_whole_near_flush_and_one_sided_facets_do_not_certify() {
    let(mut s,h,q)=actual();s[1][1]=7.0*G;
    assert!(!check(s,h,q)); // All corners lie inside the unchanged8grid band.
    s[0][1]=7.0*G;s[2][1]=G;
    assert!(!check(s,h,q)); // No strict straddle.
}
#[test]
fn issue_7292_tangential_required_rescue_preserves_original_carrier() {
    let s=[[20.0,-145.0,2700.0],[20.0,-135.0+2.0*G,2700.0],
        [1704.9996337890625,-135.0,2700.0]];
    let h=[[7049.99951171875,-135.0,0.0],[0.0,-135.0,0.0],[0.0,-135.0,3900.0]];
    assert!(!check(s,h,[20.0,-135.0,2700.0])); // Actual477 tangential move.
}
#[test]
fn issue_7292_point_and_remote_plane_contacts_do_not_certify_finite_segment() {
    let(s,h,q)=actual();let sibling=[h[0],h[2],[0.0,0.0,3900.0]];
    assert!(!check(s,sibling,q)); // Actual hostA3 meets original source only atO.
    assert!(!check(s,h.map(|p|[p[0]+100000.0,p[1],p[2]]),q));
}
#[test]
fn issue_7292_nonfinite_and_degenerate_inputs_never_certify() {
    let(mut s,h,q)=actual();assert!(!check(s,h,[f64::NAN,0.0,65.0]));
    s[0][0]=f64::INFINITY;assert!(!check(s,h,q));
    let s=[[0.0,-G,0.0],[1.0,0.0,0.0],[2.0,G,0.0]];assert!(!check(s,h,q));
}
#[test]
fn issue_7292_raw_key_rejection_is_coherent_and_admitted_paths_are_exempt() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let(s,h,q)=actual();let band=NearBand::from_operands(&[s],&[h]);let f=Face::new(h,&band).unwrap();
    let mut p=vec![Proposal{admitted_q20_face:None,ti:0,vi:0,original:s[0],target:Some(q),refused_face:Some(&f),initial_foot:Some(q)},
        Proposal{admitted_q20_face:None,ti:1,vi:0,original:s[0],target:Some(q),refused_face:Some(&f),initial_foot:Some(q)}];
    budget::begin();assert_eq!(rejected_keys(&[s,s],&p,&band),HashSet::from([vertex_bits(&s[0])]));
    p[1].refused_face=None;assert!(rejected_keys(&[s,s],&p,&band).is_empty());
    // Geometrically equal signedzero owners remain separate resolution keys.
    let shift=|p:[f64;3]|[p[0]-s[0][0],p[1],p[2]];
    let mut minus=s.map(shift);minus[0][0]= -0.0;
    let mut plus=minus;plus[0][0]=0.0;
    let shifted_host=h.map(shift);let shifted_band=NearBand::from_operands(&[minus,plus],&[shifted_host]);
    let shifted_face=Face::new(shifted_host,&shifted_band).unwrap();let mut target=shift(q);target[0]= -0.0;
    let p=[Proposal{admitted_q20_face:None,ti:0,vi:0,original:minus[0],target:Some(target),refused_face:Some(&shifted_face),initial_foot:Some(target)},
        Proposal{admitted_q20_face:None,ti:1,vi:0,original:plus[0],target:Some(target),refused_face:None,initial_foot:None}];
    assert_eq!(rejected_keys(&[minus,plus],&p,&shifted_band),HashSet::from([vertex_bits(&minus[0])]));
}
#[test]
fn issue_7292_budget_exhaustion_never_certifies_a_new_veto() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap();
    struct Reset(Option<u64>);impl Drop for Reset{fn drop(&mut self){budget::set_cap(self.0);budget::begin();}}
    let _reset=Reset(budget::cap());budget::set_cap(Some(1));budget::begin();budget::note_escalation();
    let(s,h,q)=actual();let band=NearBand::from_operands(&[s],&[h]);let f=Face::new(h,&band).unwrap();
    assert!(budget::tripped());assert!(!certificate(&s,q,&f,&band));
}

#[test]
fn issue_7292_initial_step_must_not_veto_standing_secondary_axis_completion_869305() {
    let p=[3750.0-16.0*G,110.0+G,2715.0];
    let source=[p,[-2.0,0.0,0.0],[-2.0,1.0,0.0]];
    let host=[[0.0,110.0,0.0],[3750.0,110.0,0.0],[3750.0,110.0,3250.0]];
    let initial=[p[0],110.0,p[2]];let completed=[3750.0,110.0,p[2]];
    assert!(!check(source,host,initial),"initial Y foot stays on the source carrier");
    assert!(check(source,host,completed),"distinguish refuted completed-target scope");
    let band=NearBand::from_operands(&[source],&[host]);let face=Face::new(host,&band).unwrap();
    let proposals=[Proposal{admitted_q20_face:None,ti:0,vi:0,original:p,target:Some(completed),
        refused_face:Some(&face),initial_foot:Some(initial)}];
    assert!(rejected_keys(&[source],&proposals,&band).is_empty());
}

#[test]
fn issue_7292_actual473_old_certificate_true_but_new_stability_declines_veto() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap();let _element=budget::enter_element();
    let host=[[-20.0,0.0,3900.0],[270.0006103515625,0.0,3900.0],[270.0006103515625,0.0,0.0]];
    let source=[[19.681137084960938,-10.0,3869.99951171875],[19.680282592773438,G,3869.99951171875],[19.680282592773438,G,3899.99951171875]];
    let band=NearBand::from_operands(&[source],&[host]);let face=Face::new(host,&band).unwrap();
    for index in [1,2] {
        let original=source[index];let mut initial=original;initial[1]=0.0;
        let mut completed=initial;if index==2 {completed[2]=3900.0;}
        budget::begin();assert!(certificate(&source,initial,&face,&band),"actual original V4 premise must hold");
        let proposals=[Proposal{admitted_q20_face:None,ti:0,vi:index,original,target:Some(completed),refused_face:Some(&face),initial_foot:Some(initial)}];
        let rejected=rejected_keys(&[source],&proposals,&band);
        assert!(rejected.is_empty(),"actual473 stability guard must decline recorded low/high veto");
        assert!(!budget::tripped());
    }
}
