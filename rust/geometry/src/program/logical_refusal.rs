// SPDX-License-Identifier: MPL-2.0
//! Owned four-byte refusal tokens. Only errors access the synchronized detail
//! registry; successful budget debits neither initialize nor consult it.
use crate::router::diagnostics::BudgetProductIdentity;
use std::sync::Mutex;

#[derive(Debug)]
#[repr(transparent)]
pub(crate) struct LogicalRefusal(u32);

const _: () = assert!(std::mem::size_of::<LogicalRefusal>() == 4);
const _: () = assert!(std::mem::size_of::<Result<u32, LogicalRefusal>>() == 8);
// Plain u32 deliberately retains main's unit-Result layout, without a niche.
const _: () = assert!(std::mem::size_of::<Result<(), LogicalRefusal>>() == 8);

struct Detail {
    limit: u32,
    reached: u64,
    budget: &'static str,
    product: Option<BudgetProductIdentity>,
}

struct Registry {
    slots: Vec<Option<Detail>>,
    free: Vec<u32>,
}

static REFUSALS: Mutex<Registry> = Mutex::new(Registry { slots: Vec::new(), free: Vec::new() });

impl LogicalRefusal {
    #[cold]
    #[inline(never)]
    pub(super) fn exceeded(limit: u32, used: u32, count: usize) -> Self {
        let detail = Detail { limit, reached: u64::from(used).saturating_add(count as u64),
            budget: "logical Items members", product: None };
        let mut registry = REFUSALS.lock().expect("logical refusal registry poisoned");
        let id = if let Some(id) = registry.free.pop() {
            registry.slots[id as usize] = Some(detail);
            id
        } else {
            let id = u32::try_from(registry.slots.len()).expect("too many live logical refusals");
            registry.slots.push(Some(detail));
            id
        };
        Self(id)
    }

    #[cold]
    #[inline(never)]
    fn with_detail<T>(&self, f: impl FnOnce(&mut Detail) -> T) -> T {
        let mut registry = REFUSALS.lock().expect("logical refusal registry poisoned");
        f(registry.slots[self.0 as usize].as_mut().expect("live logical refusal slot"))
    }

    #[cold]
    pub(in crate::program) fn set_budget(&mut self, budget: &'static str) {
        self.with_detail(|detail| detail.budget = budget);
    }

    #[cold]
    pub(in crate::program) fn attach_product(&mut self, product: &ifc_lite_core::DecodedEntity) {
        let identity = BudgetProductIdentity::from_product(product);
        self.with_detail(|detail| detail.product = Some(identity));
    }

    #[cold]
    pub(in crate::program) fn product(&self) -> Option<BudgetProductIdentity> {
        self.with_detail(|detail| detail.product.clone())
    }

    #[cold]
    pub(in crate::program) fn details(&self) -> (&'static str, u32, u64) {
        self.with_detail(|detail| (detail.budget, detail.limit, detail.reached))
    }

    #[cold]
    pub(in crate::program) fn to_error(&self, item: u32) -> crate::Error {
        let (budget, limit, reached) = self.details();
        crate::representation::WalkRefusal::work_budget(limit, budget, reached).into_error(item)
    }
}

impl Drop for LogicalRefusal {
    #[cold]
    #[inline(never)]
    fn drop(&mut self) {
        let detail = {
            let mut registry = REFUSALS.lock().expect("logical refusal registry poisoned");
            let detail = registry.slots[self.0 as usize].take().expect("live logical refusal slot");
            registry.free.push(self.0);
            detail
        };
        // Release owned identity strings after unlocking; slots track only
        // outstanding tokens and are reused after every discarded/accepted error.
        drop(detail);
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "logical_refusal_tests.rs"]
mod tests;
