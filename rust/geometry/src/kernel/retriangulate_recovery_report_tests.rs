// #7292: crossed constraints can cycle within a pass and return the same mesh.
use super::*;
use crate::kernel::{budget, retriangulate_audit::audit_and_recover,
    retriangulate_recover::{between, enforce_constraint, recover_subsegment}};
#[path = "retriangulate_recovery_report_fixture.rs"]
mod actual;

fn point(x:f64,y:f64)->ImplicitPoint { ImplicitPoint::Explicit([x,y,0.]) }
fn square()->(Interner,Mesh2d,Canonical) {
    let mut it=Interner::new();
    let a=it.intern(point(0.,0.));let b=it.intern(point(2.,0.));
    let c=it.intern(point(2.,2.));let d=it.intern(point(0.,2.));
    let mesh=Mesh2d {tris:vec![[a,b,c],[a,c,d]],axis:DropAxis::Z,w0:Sign::Positive,
        unrecovered:0,audit_needed:false,coords:BTreeMap::new()};
    let canon=Canonical {corners:[a,b,c],segments:vec![(a,c),(b,d)],points:vec![]};
    (it,mesh,canon)
}
fn missing(mesh:&Mesh2d,it:&Interner,canon:&Canonical)->usize {
    let mut total=0;
    for &(s,t) in &canon.segments {
        let mut on:Vec<_>=mesh.tris.iter().flatten().copied().collect::<BTreeSet<_>>()
            .into_iter().filter(|&v|v!=s&&v!=t&&orient2d_v(it,s,t,v,mesh.axis)==Sign::Zero&&between(it,s,t,v)).collect();
        on.sort_by(|&x,&y|lex_cmp(it,x,y));
        if cmp_lex_v(it,s,t)==Sign::Positive {on.reverse();}
        let mut chain=vec![s];chain.extend(on);chain.push(t);
        total+=chain.windows(2).filter(|w|!edge_exists(mesh,w[0],w[1])).count();
    }
    total
}
#[test]
fn issue_7292_net_unchanged_crossed_diagonal_pass_cannot_report_zero() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _element=budget::enter_element();budget::begin();
    let (it,mut mesh,canon)=square();
    let converged=passes::recover(&mut mesh,&it,&canon.segments);
    if !converged {mesh.audit_needed=true;}
    if mesh.audit_needed {let axis=mesh.axis;audit_and_recover(&mut mesh,&it,&canon,axis);}
    assert!(!budget::tripped());
    assert!(missing(&mesh,&it,&canon)>0,"two crossing diagonals without a crossing vertex cannot both be mesh edges");
    assert!(mesh.unrecovered>0,"net-unchanged recovery must not silently report zero unrecovered constraints");
}
#[test]
fn issue_7292_actual794_b65_crossed_constraints_recover_or_report() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _element=budget::enter_element();budget::begin();
    let input=actual::input();let mut it=Interner::new();
    let mesh=triangulate(&input,&mut it).expect("actual nondegenerate B65");
    let canon=canonicalize(&input,&mut it);
    assert!(!budget::tripped());
    assert!(missing(&mesh,&it,&canon)==0||mesh.unrecovered>0,
        "actual crossed raw/cop B65 constraints must be recovered or reported, never silently zero");
}
#[test]
fn issue_7292_attempt_flag_reuses_existing_edge_gate_and_reports_bail() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let _element=budget::enter_element();budget::begin();
    let (mut it,mut mesh,canon)=square();let (a,c)=canon.segments[0];
    assert!(!recover_subsegment(&mut mesh,&it,a,c));
    assert!(!enforce_constraint(&mut mesh,&it,a,c));
    let outside=it.intern(point(3.,3.));
    assert!(recover_subsegment(&mut mesh,&it,a,outside),"missing edge is attempted even if its channel bails");
    assert!(mesh.audit_needed);assert!(!budget::tripped());
}
#[test]
fn issue_7292_tripped_budget_does_not_start_recovery_or_final_audit() {
    let _lock=budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    struct Reset(Option<u64>);impl Drop for Reset{fn drop(&mut self){budget::set_cap(self.0);budget::begin();}}
    let _reset=Reset(budget::cap());let _element=budget::enter_element();
    let (it,mut mesh,canon)=square();let before=mesh.tris.clone();
    budget::set_cap(Some(1));budget::begin();budget::note_escalation();
    assert!(budget::tripped());let counters=budget::snapshot_counters();
    assert!(!passes::recover(&mut mesh,&it,&canon.segments));
    let axis=mesh.axis;audit_and_recover(&mut mesh,&it,&canon,axis);
    assert_eq!(mesh.tris,before);assert_eq!(budget::snapshot_counters(),counters);
    assert!(budget::tripped(),"partial audit must preserve the standing discard signal");
    // A tripped audit is partial and MUST be discarded by its standing caller;
    // no residual count here is claimed to certify conformance.
}
