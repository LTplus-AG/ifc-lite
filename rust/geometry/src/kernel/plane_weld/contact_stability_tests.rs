// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
const G: f64 = 1.0 / 65536.0;
fn actual946() -> (Tri, Tri, [f64;3]) {
    ([[3729.999755859375,-7.0*G,65.0],[0.0,13.0*G,65.0],[0.0,0.0,0.0]],
     [[0.0,0.0,0.0],[3750.0,0.0,0.0],[3750.0,0.0,3900.0]], [3729.999755859375,0.0,65.0])
}
fn check(source:Tri, host:Tri, original:[f64;3], foot:[f64;3]) -> bool {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap();let _element=budget::enter_element();
    budget::begin(); let band=NearBand::from_operands(&[source],&[host]);
    escapes_original_contact(&source,original,foot,&Face::new(host,&band).unwrap(),&band)
}
fn v(p:[f64;3])->V {vector(p).unwrap()}
fn body(noise:[f64;3], floor:f64)->Body {Body{noise:v(noise),floor:R::from_float(floor).unwrap()}}
#[test]
fn issue_7292_actual946_escape_is_axis_winding_and_corner_order_independent() {
    let(s,h,f)=actual946();
    for axis in 0..3 { for reverse in [false,true] {for rotate in 0..3 {
        let map=|p:[f64;3]|[p[axis],p[(axis+1)%3],p[(axis+2)%3]];
        let mut src=[s[rotate],s[(rotate+1)%3],s[(rotate+2)%3]].map(map);let mut host=h.map(map);
        if reverse {src.swap(0,1);host.swap(0,1);}
        assert!(check(src,host,map(s[0]),map(f)));
    }}}
}
#[test]
fn issue_7292_actual473_recorded_facet_initial_feet_do_not_escape() {
    let h=[[-20.0,0.0,3900.0],[270.0006103515625,0.0,3900.0],[270.0006103515625,0.0,0.0]];
    let s=[[19.681137084960938,-10.0,3869.99951171875],[19.680282592773438,G,3869.99951171875],[19.680282592773438,G,3899.99951171875]];
    for i in [1,2] {let mut foot=s[i];foot[1]=0.0;assert!(!check(s,h,s[i],foot));}
    let s=[[250.0006103515625,-10.0,90.0],[250.00059509277344,0.0,2700.0],[250.00059509277344,G,90.0]];
    let mut foot=s[2];foot[1]=0.0;assert!(!check(s,h,s[2],foot));
}
#[test]
fn issue_7292_infinite_support_ignores_host_internal_diagonal() {
    let(s,h,f)=actual946();let sibling=[h[0],h[2],[0.0,0.0,3900.0]];
    assert!(check(s,h,s[0],f));assert!(check(s,sibling,s[0],f));
    // This helper intentionally does NOT assert the old finite-Segment premise
    // for sibling: that separate standing eligibility test remains unchanged.
}
#[test]
fn issue_7292_symmetric_contact_loss_and_point_collapse_are_not_zero_motion() {
    let b=body([0.0;3],0.25);let old=[v([0.0,0.0,0.0]),v([2.0,0.0,0.0])];let new=[v([0.0,0.0,0.0]),v([1.0,0.0,0.0])];
    assert!(!new.iter().any(|p|endpoint_escapes(p,&old,&b)));
    assert!(either_direction_escapes(&old,&new,&b));
    assert!(either_direction_escapes(&old,&new[..1],&b));
    let s=[[0.0,7.0*G,0.0],[2.0,-13.0*G,0.0],[2.0,-13.0*G,2.0]];
    let h=[[-4.0,0.0,-2.0],[4.0,0.0,-2.0],[0.0,0.0,8.0]];
    assert!(check(s,h,s[0],[0.0,0.0,0.0]));
}
#[test]
fn issue_7292_support_boundary_and_zero_residual_are_not_escape() {
    let f=8.0*G;let b=body([0.0;3],f);let point=[v([0.0;3])];
    assert!(!endpoint_escapes(&v([0.0;3]),&point,&b));
    assert!(!endpoint_escapes(&v([f,0.0,0.0]),&point,&b));
    assert!(!endpoint_escapes(&v([f64::from_bits(f.to_bits()-1),0.0,0.0]),&point,&b));
    assert!(endpoint_escapes(&v([f64::from_bits(f.to_bits()+1),0.0,0.0]),&point,&b));
}
#[test]
fn issue_7292_anisotropic_support_is_directional_and_nonexclusion_undecided() {
    let b=body([10.0,1.0,1.0],1.0);let segment=[v([0.0,0.0,-1.0]),v([0.0,0.0,1.0])];
    let p=v([9.0,2.0,0.0]);assert!(p[1]>b.noise[1]);
    assert!(!endpoint_escapes(&p,&segment,&b),"outside anisotropic body can remain undecided");
    assert!(!endpoint_escapes(&v([9.0,0.0,0.0]),&segment,&b));
    assert!(endpoint_escapes(&v([0.0,2.0,0.0]),&segment,&b));
    // Exercise the central NearBand basis behaviorally, not only a manually
    // supplied Body: a large X coordinate must not widen Y uncertainty.
    let band=NearBand::from_tris(&[[[1073741824.0,0.0,0.0],[1073741952.0,0.0,0.0],[1073741824.0,0.0,1.0]]]);
    let paired=Body::new(&band).unwrap();let origin=[v([0.0;3])];
    assert!(!endpoint_escapes(&v([256.0,0.0,0.0]),&origin,&paired));
    assert!(endpoint_escapes(&v([0.0,1.0,0.0]),&origin,&paired));
    let mut reverse=segment.clone();reverse.reverse();
    assert_eq!(endpoint_escapes(&p,&segment,&b),endpoint_escapes(&p,&reverse,&b));
}
#[test]
fn issue_7292_invalid_planes_raw_corner_ambiguity_and_noninitial_targets_decline() {
    let(s,h,f)=actual946();assert!(!check(s,h,[99.0;3],f));
    let duplicate=[s[0],s[0],s[1]];assert!(!check(duplicate,h,s[0],f));
    let mut not_axis=f;not_axis[0]+=1.0;assert!(!check(s,h,s[0],not_axis));
    let mut off=f;off[1]=G;assert!(!check(s,h,s[0],off));
    let mut nan=s;nan[0][0]=f64::NAN;assert!(!check(nan,h,s[0],f));
    let tilted=[h[0],h[1],[h[2][0],G,h[2][2]]];assert!(!check(s,tilted,s[0],f));
}
#[test]
fn issue_7292_empty_coplanar_contacts_are_undecided_and_raw_zero_identity_matters() {
    let t=[v([0.0,0.0,0.0]),v([1.0,0.0,0.0]),v([0.0,0.0,1.0])];
    assert!(contact(&t,1,&R::zero()).is_none());
    assert!(contact(&t,1,&R::from_integer(1.into())).is_none());
    let (s,h,f)=actual946();let mut source=s;source[0][2]= -0.0;let mut original=source[0];original[2]=0.0;
    let mut foot=f;foot[2]= -0.0;assert!(!check(source,h,original,foot));
}
#[test]
fn issue_7292_shared_raw_key_owner_order_and_primary_exemption_preserve_transactions() {
    use super::super::transversal::{rejected_keys, Proposal};
    let(s,h,foot)=actual946();
    let stable=[s[0],[s[0][0]+G,13.0*G,65.0],[s[0][0],0.0,0.0]];
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap();let _element=budget::enter_element();
    let band=NearBand::from_operands(&[s,stable],&[h]);let face=Face::new(h,&band).unwrap();
    budget::begin();assert!(!escapes_original_contact(&stable,s[0],foot,&face,&band));
    for owners in [[s,stable],[stable,s]] {for reverse in [false,true] {
        let mut proposals=[Proposal{admitted_q20_face:None,ti:0,vi:0,original:s[0],target:Some(foot),refused_face:Some(&face),initial_foot:Some(foot)},
            Proposal{admitted_q20_face:None,ti:1,vi:0,original:s[0],target:Some(foot),refused_face:Some(&face),initial_foot:Some(foot)}];
        if reverse {proposals.reverse();}budget::begin();
        assert_eq!(rejected_keys(&owners,&proposals,&band),std::collections::HashSet::from([vertex_bits(&s[0])]));
        proposals[0].refused_face=None;
        assert!(rejected_keys(&owners,&proposals,&band).is_empty());
    }}
}
#[test]
fn issue_7292_projected_support_boundary_and_pretripped_budget_decline() {
    let b=body([10.0,1.0,1.0],1.0);let p=[v([0.0;3])];
    assert!(!endpoint_escapes(&v([10.0,0.0,0.0]),&p,&b));
    assert!(endpoint_escapes(&v([f64::from_bits(10.0_f64.to_bits()+1),0.0,0.0]),&p,&b));
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap();
    struct Reset(Option<u64>);impl Drop for Reset {fn drop(&mut self){budget::set_cap(self.0);budget::begin();}}
    let _reset=Reset(budget::cap());budget::set_cap(Some(1));let _element=budget::enter_element();budget::begin();budget::note_escalation();
    let(s,h,foot)=actual946();let band=NearBand::from_operands(&[s],&[h]);let face=Face::new(h,&band).unwrap();
    assert!(budget::tripped());assert!(!escapes_original_contact(&s,s[0],foot,&face,&band));
    budget::begin();assert!(!budget::tripped());
    assert!(!escapes_original_contact(&s,s[0],foot,&face,&band));
    assert!(budget::tripped(),"bounded exact query must charge existing cap");
}
