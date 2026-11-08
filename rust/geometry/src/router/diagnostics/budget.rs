// SPDX-License-Identifier: MPL-2.0
//! Work-budget refusals are safety-policy diagnostics, never unsupported items.
use super::GeometryRouter;
use ifc_lite_core::DecodedEntity;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
impl GeometryRouter {
    pub(crate) fn record_budget_refusal(&self, source_id: u32, budget: &str, limit: u32, reached: u64) {
        self.unsupported.borrow_mut().budget_refusals.push(BudgetRefusal {
            budget: budget.into(), limit, reached, source_id,
            product_id: None, product_type: None, global_id: None,
        });
    }
    pub(crate) fn attribute_budget_refusals(&self, product: &DecodedEntity) {
        for refusal in &mut self.unsupported.borrow_mut().budget_refusals {
            if refusal.product_id.is_none() {
                refusal.product_id = Some(product.id);
                refusal.product_type = Some(product.ifc_type.to_string());
                refusal.global_id = product.get(0).and_then(|a| a.as_string()).map(str::to_owned);
            }
        }
    }
    pub fn take_budget_refusals(&self) -> Vec<BudgetRefusal> {
        std::mem::take(&mut self.unsupported.borrow_mut().budget_refusals)
    }
}
