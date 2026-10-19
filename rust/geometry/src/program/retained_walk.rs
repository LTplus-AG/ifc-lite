// SPDX-License-Identifier: MPL-2.0
//! Root-owned bounds across existing retained controllers. A lexical scope only
//! selects immutable ancestry; the shared monotonic budget survives every reply.
use crate::resource::{self,Dimension,ProgramStop,RefusalReason,ResourceFailure};
use std::{cell::RefCell,sync::{Arc,Mutex}};
use ifc_lite_core::MAX_MAPPED_ITEM_DEPTH;
use crate::processors::boolean::MAX_OPERAND_VISITS;

// One Boolean operand allowance per mapped tier, shared across child programs.
// Unlike ambient Compatibility accounting this admission is always finite.
const WORK_LIMIT:u64=MAX_OPERAND_VISITS as u64 * MAX_MAPPED_ITEM_DEPTH as u64;
struct Budget {
    spent:u64,limit:u64,terminal:Option<ProgramStop>,
    #[cfg(test)]
    sites:std::collections::BTreeMap<(&'static str,u32),(u64,u64)>,
}
#[derive(Clone)]
pub(super) struct RetainedWalk {budget:Arc<Mutex<Budget>>,path:Arc<Vec<u32>>}
thread_local! {static CURRENT:RefCell<Option<RetainedWalk>>=const {RefCell::new(None)};}
pub(super) struct WalkScope {prior:Option<RetainedWalk>}
impl Drop for WalkScope {
    fn drop(&mut self) {CURRENT.with(|slot|{slot.replace(self.prior.take());});}
}
impl RetainedWalk {
    fn fresh(path:Vec<u32>)->Self {
        Self {budget:Arc::new(Mutex::new(Budget {spent:0,limit:WORK_LIMIT,terminal:None,
            #[cfg(test)] sites:Default::default()})),
            path:Arc::new(path)}
    }
    pub(super) fn root(id:u32)->Self { Self::fresh(vec![id]) }
    /// A styled plain-item wrapper delegates to the same reached leaf. Only
    /// that leaf enters its id; a standalone wrapper still owns a finite budget.
    pub(super) fn wrapper()->Self { current().unwrap_or_else(||Self::fresh(Vec::new())) }
    #[cfg_attr(test,track_caller)]
    pub(super) fn child(id:u32)->crate::Result<Self> {
        let Some(parent)=current() else {return Ok(Self::root(id))};
        parent.charge(1)?;
        // The immutable parent path is scoped to this occurrence. Sibling/reused
        // DAG occurrences inherit the parent, never another sibling's membership.
        if parent.path.contains(&id) || parent.path.len()>=MAX_MAPPED_ITEM_DEPTH as usize {
            return Err(parent.refuse(Dimension::Representation,parent.path.len() as u64+1,0).into());
        }
        let mut path=Vec::new();
        resource::reserve_headers(&mut path,parent.path.len()+1)?.retain();
        path.extend_from_slice(&parent.path);path.push(id);
        resource::charge(resource::Cost {live_bytes:std::mem::size_of::<Vec<u32>>() as u64
            +2*std::mem::size_of::<usize>() as u64,..Default::default()})?.retain();
        Ok(Self {budget:parent.budget,path:Arc::new(path)})
    }
    pub(super) fn check(&self)->Result<(),ProgramStop> {
        let stop=self.budget.lock().unwrap_or_else(|e|e.into_inner()).terminal;
        match stop {Some(stop)=>Err(stop),None=>Ok(())}
    }
    fn refuse(&self,dimension:Dimension,requested:u64,remaining:u64)->ProgramStop {
        // Polling has no source lease and must not debit/poison an unrelated
        // ambient account. The typed root terminal is carried to processing,
        // whose captured resource authority decides the enclosing first fault.
        let stop=ProgramStop::ResourceRefused(ResourceFailure {dimension,requested,remaining,reason:RefusalReason::Limit});
        let mut budget=self.budget.lock().unwrap_or_else(|e|e.into_inner());
        *budget.terminal.get_or_insert(stop)
    }
    #[cfg_attr(test,track_caller)]
    fn charge(&self,work:u64)->Result<(),ProgramStop> {
        self.check()?;
        let mut budget=self.budget.lock().unwrap_or_else(|e|e.into_inner());
        let remaining=budget.limit.saturating_sub(budget.spent);
        if work>remaining {
            #[cfg(test)]
            budget.report_refusal(work,remaining,std::panic::Location::caller());
            drop(budget);return Err(self.refuse(Dimension::Work,work,remaining));
        }
        #[cfg(test)]
        budget.note(work,std::panic::Location::caller());
        budget.spent+=work;Ok(())
    }
    /// Validated reply adapters accept recursively without fallible envelope
    /// debits. Reinstall captured ancestry; actual effects charge their work.
    pub(super) fn acceptance_scope(&self)->Result<WalkScope,ProgramStop> {
        self.check()?;
        Ok(WalkScope {prior:CURRENT.with(|slot|slot.replace(Some(self.clone())))})
    }
    #[cfg_attr(test,track_caller)]
    pub(super) fn scope(&self)->Result<WalkScope,ProgramStop> {
        self.charge(1)?;
        Ok(WalkScope {prior:CURRENT.with(|slot|slot.replace(Some(self.clone())))})
    }
    #[cfg(test)]
    pub(super) fn spent_for_test(&self)->u64 {
        self.budget.lock().unwrap_or_else(|e|e.into_inner()).spent
    }
    #[cfg(test)]
    pub(super) fn set_test_work_limit(&self,limit:u64) {
        self.budget.lock().unwrap_or_else(|e|e.into_inner()).limit=limit;
    }
}
pub(super) fn current()->Option<RetainedWalk> {CURRENT.with(|slot|slot.borrow().clone())}
#[cfg_attr(test,track_caller)]
pub(super) fn charge(work:u64)->crate::Result<()> {
    match current() {Some(walk)=>walk.charge(work).map_err(Into::into),None=>Ok(())}
}

#[cfg(test)]
#[path="retained_walk_accept_tests.rs"]
mod accept_tests;

// Bounded test-only attribution for real retained traversal failures. No source
// contents, resource/TLS mutation or numerical policy enter this diagnostic.
#[cfg(test)]
impl Budget {
    fn note(&mut self,work:u64,caller:&'static std::panic::Location<'static>) {
        let key=(caller.file(),caller.line());
        // Call sites are compile-time locations, but bound storage explicitly.
        let key=if self.sites.contains_key(&key) || self.sites.len()<127 {key} else {("<other>",0)};
        let count=self.sites.entry(key).or_default();count.0+=work;count.1+=1;
    }
    fn report_refusal(&self,requested:u64,remaining:u64,caller:&std::panic::Location<'_>) {
        eprintln!("retained walk Work refusal: spent={} limit={} requested={} remaining={} at {}:{}",
            self.spent,self.limit,requested,remaining,caller.file(),caller.line());
        for ((file,line),(work,calls)) in &self.sites {
            eprintln!("retained walk accepted site {file}:{line}: work={work} calls={calls}");
        }
    }
}
