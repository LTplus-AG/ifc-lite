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
struct Budget {spent:u64,limit:u64,terminal:Option<ProgramStop>}
#[derive(Clone)]
pub(super) struct RetainedWalk {budget:Arc<Mutex<Budget>>,path:Arc<Vec<u32>>}
thread_local! {static CURRENT:RefCell<Option<RetainedWalk>>=const {RefCell::new(None)};}
pub(super) struct WalkScope {prior:Option<RetainedWalk>}
impl Drop for WalkScope {
    fn drop(&mut self) {CURRENT.with(|slot|{slot.replace(self.prior.take());});}
}
impl RetainedWalk {
    pub(super) fn root(id:u32)->Self {
        Self {budget:Arc::new(Mutex::new(Budget {spent:0,limit:WORK_LIMIT,terminal:None})),
            path:Arc::new(vec![id])}
    }
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
    fn charge(&self,work:u64)->Result<(),ProgramStop> {
        self.check()?;
        let mut budget=self.budget.lock().unwrap_or_else(|e|e.into_inner());
        let remaining=budget.limit.saturating_sub(budget.spent);
        if work>remaining {drop(budget);return Err(self.refuse(Dimension::Work,work,remaining));}
        budget.spent+=work;Ok(())
    }
    /// Validated reply adapters accept recursively without fallible envelope
    /// debits. Reinstall captured ancestry; actual effects charge their work.
    pub(super) fn acceptance_scope(&self)->Result<WalkScope,ProgramStop> {
        self.check()?;
        Ok(WalkScope {prior:CURRENT.with(|slot|slot.replace(Some(self.clone())))})
    }
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
pub(super) fn charge(work:u64)->crate::Result<()> {
    match current() {Some(walk)=>walk.charge(work).map_err(Into::into),None=>Ok(())}
}

#[cfg(test)]
#[path="retained_walk_accept_tests.rs"]
mod accept_tests;
