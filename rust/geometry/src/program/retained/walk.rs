// SPDX-License-Identifier: MPL-2.0
//! One finite retained traversal budget, independent of exact walk limits.
use crate::resource::{Dimension, ProgramStop, RefusalReason, ResourceFailure};
use std::sync::Mutex;

pub(super) struct RetainedWalk(Mutex<Budget>, pub(super) super::failure::FailureSlot);
struct Budget { spent: u64, limit: u64, terminal: Option<ProgramStop> }
impl RetainedWalk {
    pub(super) fn new() -> Self {
        let (failure, terminal) = super::failure::FailureSlot::new();
        Self(Mutex::new(Budget { spent: 0,
            limit: crate::processors::boolean::MAX_OPERAND_VISITS as u64
                * ifc_lite_core::MAX_MAPPED_ITEM_DEPTH as u64,
            terminal }), failure)
    }
    pub(super) fn check(&self) -> Result<(), ProgramStop> {
        match self.0.lock().unwrap_or_else(|e| e.into_inner()).terminal {
            Some(stop) => Err(stop), None => Ok(()),
        }
    }
    pub(super) fn charge(&self, work: u64) -> Result<(), ProgramStop> {
        let mut budget = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(stop) = budget.terminal { return Err(stop); }
        let remaining = budget.limit.saturating_sub(budget.spent);
        if work > remaining {
            let stop = refusal(Dimension::Work, work, remaining);
            budget.terminal = Some(stop);
            return Err(stop);
        }
        budget.spent += work;
        Ok(())
    }
    /// The caller's explicit active mapping stack is path-scoped. Reusing a
    /// source on a sibling branch remains a real occurrence, never a revisit.
    pub(super) fn enter(&self, id: u32, path: &[u32]) -> Result<(), ProgramStop> {
        self.check()?;
        if path.contains(&id) || path.len() >= ifc_lite_core::MAX_MAPPED_ITEM_DEPTH as usize {
            let mut budget = self.0.lock().unwrap_or_else(|e| e.into_inner());
            let stop = refusal(Dimension::Representation, path.len() as u64 + 1, 0);
            return Err(*budget.terminal.get_or_insert(stop));
        }
        self.charge(1)
    }
    pub(super) fn remember(&self, stop: ProgramStop) -> ProgramStop {
        let mut budget = self.0.lock().unwrap_or_else(|e| e.into_inner());
        *budget.terminal.get_or_insert(stop)
    }
    pub(super) fn refuse(&self, requested: u64) -> ProgramStop {
        let mut budget = self.0.lock().unwrap_or_else(|e| e.into_inner());
        *budget.terminal.get_or_insert_with(|| refusal(Dimension::Representation, requested, 0))
    }
    #[cfg(test)]
    pub(super) fn set_limit(&self, limit: u64) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).limit = limit;
    }
}
fn refusal(dimension: Dimension, requested: u64, remaining: u64) -> ProgramStop {
    ProgramStop::ResourceRefused(ResourceFailure {
        dimension, requested, remaining, reason: RefusalReason::Limit,
    })
}
