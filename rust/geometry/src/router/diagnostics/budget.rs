// SPDX-License-Identifier: MPL-2.0
//! Work-budget refusals are safety-policy diagnostics, never unsupported items.
use super::GeometryRouter;
use ifc_lite_core::{slot::IfcRoot, DecodedEntity};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct BudgetRefusal {
    pub budget: String,
    pub limit: u32,
    /// Demand including the refused attempt/list, rather than only admitted work.
    pub reached: u64,
    pub source_id: u32,
    pub product_id: Option<u32>,
    pub product_type: Option<String>,
    #[serde(rename = "GlobalId")]
    pub global_id: Option<String>,
}

/// Maximum retained detail records per diagnostic drain. Counts remain complete.
pub const BUDGET_REFUSAL_DETAILS_LIMIT: usize = 16;

#[derive(Default)]
pub(super) struct BudgetRefusalLog {
    entries: Vec<BudgetRefusal>,
    seen: rustc_hash::FxHashSet<(Option<u32>, u32, String, u64)>,
}

impl GeometryRouter {
    #[cold]
    #[inline(never)]
    pub(crate) fn record_budget_refusal(&self, source_id: u32, budget: &str, limit: u32,
        reached: u64, product: Option<&DecodedEntity>) {
        let mut state = self.unsupported.borrow_mut();
        let log = state.budget_refusals.get_or_insert_with(Box::default);
        if !log.seen.insert((product.map(|p| p.id), source_id, budget.into(), reached)) {
            return;
        }
        if log.entries.len() < BUDGET_REFUSAL_DETAILS_LIMIT {
            log.entries.push(BudgetRefusal {
                budget: budget.into(), limit, reached, source_id,
                product_id: product.map(|p| p.id),
                product_type: product.map(|p| p.ifc_type.to_string()),
                global_id: product.and_then(|p| p.get(IfcRoot::GLOBAL_ID.index()))
                    .and_then(|a| a.as_string()).map(str::to_owned),
            });
        }
    }

    /// Drain bounded details and the complete distinct-refusal count together.
    /// The dedup set lives until this drain, including across repeated walks.
    pub fn take_budget_refusal_report(&self) -> (u64, Vec<BudgetRefusal>) {
        self.unsupported.borrow_mut().budget_refusals.take()
            .map_or_else(|| (0, Vec::new()), |log| (log.seen.len() as u64, log.entries))
    }

    /// Drain the bounded detail list. Use `take_budget_refusal_report` for totals.
    pub fn take_budget_refusals(&self) -> Vec<BudgetRefusal> {
        self.take_budget_refusal_report().1
    }
}
