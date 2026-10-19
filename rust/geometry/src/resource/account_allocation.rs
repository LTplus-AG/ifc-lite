// SPDX-License-Identifier: MPL-2.0
//! Direct same-account ledger. No ambient account, terminal scope or permit table.
use super::{Inner, State};
use crate::resource::{Dimension, ProgramStop, RefusalReason, ResourceFailure};
use ifc_lite_core::execution_owner::{AllocationAccount, AllocationClass, AllocationCost};
use std::sync::atomic::Ordering;

fn checked(used: u64, requested: u64, limit: Option<u64>, dimension: Dimension)
    -> Result<u64, ProgramStop> {
    let next = used.checked_add(requested);
    match next {
        Some(next) if limit.is_none_or(|limit| next <= limit) => Ok(next),
        _ => Err(ProgramStop::ResourceRefused(ResourceFailure { dimension, requested,
            remaining: limit.unwrap_or(u64::MAX).saturating_sub(used),
            reason: if next.is_none() { RefusalReason::Overflow } else { RefusalReason::Limit } })),
    }
}
impl Inner {
    fn check_allocation_state(&self, state: &mut State) -> Result<(), ProgramStop> {
        if state.terminal.is_none() && self.cancelled.load(Ordering::Acquire) {
            state.terminal = Some(ProgramStop::Cancelled);
        }
        state.terminal.map_or(Ok(()), Err)
    }
}
impl AllocationAccount for Inner {
    fn check(&self) -> Result<(), ProgramStop> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.check_allocation_state(&mut state)
    }
    fn admit(&self, cost: AllocationCost) -> Result<(), ProgramStop> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.check_allocation_state(&mut state)?;
        let result = (|| {
            let work = checked(state.usage.work, cost.work, self.limits.work, Dimension::Work)?;
            let copies = checked(state.usage.copy_bytes, cost.copies, self.limits.copy_bytes, Dimension::CopyBytes)?;
            // This new path retains admitted attempted work/copy costs even if
            // live admission fails. Legacy prepare_inner remains all-or-nothing.
            state.usage.work = work;
            state.usage.copy_bytes = copies;
            let live = checked(state.usage.live_bytes, cost.live, self.limits.live_bytes, Dimension::LiveBytes)?;
            let category = match cost.class {
                AllocationClass::Container => state.tracked_live,
                AllocationClass::Metadata => state.metadata_live,
            };
            let category = checked(category, cost.live, None, Dimension::LiveBytes)?;
            state.usage.live_bytes = live;
            state.usage.peak_live_bytes = state.usage.peak_live_bytes.max(live);
            match cost.class {
                AllocationClass::Container => state.tracked_live = category,
                AllocationClass::Metadata => state.metadata_live = category,
            }
            Ok(())
        })();
        if let Err(stop) = result { state.terminal.get_or_insert(stop); }
        result
    }
    fn refund(&self, bytes: u64, class: AllocationClass) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let category = match class {
            AllocationClass::Container => state.tracked_live,
            AllocationClass::Metadata => state.metadata_live,
        };
        match (category.checked_sub(bytes), state.usage.live_bytes.checked_sub(bytes)) {
            (Some(category), Some(total)) => {
                state.usage.live_bytes = total;
                match class {
                    AllocationClass::Container => state.tracked_live = category,
                    AllocationClass::Metadata => state.metadata_live = category,
                }
            }
            _ => { state.terminal.get_or_insert(ProgramStop::ResourceRefused(ResourceFailure {
                dimension: Dimension::Coverage, requested: bytes, remaining: category,
                reason: RefusalReason::UnsupportedCoverage })); }
        }
    }
    fn stop(&self, stop: ProgramStop) -> ProgramStop {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        *state.terminal.get_or_insert(stop)
    }
}
