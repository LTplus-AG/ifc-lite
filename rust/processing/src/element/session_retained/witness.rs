// SPDX-License-Identifier: MPL-2.0
use super::*;
/// Owned intermediate evidence. This deliberately exposes no final mesh/product.
pub struct RuntimeProductWitness<R: NumericalReceipt> {
    plan: RetainedProductPlan,
    ledger: Vec<(LogicalRetainedValue, Arc<RuntimeRealization<R>>)>,
    lifecycle: ProductionLifecycle,
    resources: OwnedResourceContext,
    _permits: Vec<Reservation>,
}
impl<R: NumericalReceipt> RuntimeProductWitness<R> {
    pub fn validate(&self) -> Result<(), RetainedExecutionError> {
        self.resources
            .check()
            .map_err(RetainedExecutionError::Stopped)?;
        self.lifecycle
            .validate()
            .map_err(|_| RetainedExecutionError::Source)?;
        for (_, realization) in &self.ledger {
            realization.validate_live().map_err(protocol)?;
        }
        Ok(())
    }
    /// Intermediate evidence never grants final-product publication authority.
    pub fn require_final_product(&self) -> Result<(), RetainedExecutionError> {
        self.validate()?;
        Err(RetainedExecutionError::Unsupported(
            "retained final publication requires opening/layer/appearance/face proofs"))
    }
    pub fn plan(&self) -> &RetainedProductPlan {
        &self.plan
    }
    pub fn discharged_count(&self) -> usize {
        self.ledger.len()
    }
}
impl<R: NumericalReceipt> RuntimeProductExecution<'_, R> {
    pub fn into_witness(mut self) -> Result<RuntimeProductWitness<R>, RetainedExecutionError> {
        self.validate_witness()?;
        let plan = self
            .plan
            .take()
            .ok_or_else(|| protocol("unfinished product"))?;
        Ok(RuntimeProductWitness {
            plan,
            ledger: std::mem::take(&mut self.ledger),
            _permits: std::mem::take(&mut self.permits),
            lifecycle: self.context.lifecycle(),
            resources: self.resources.clone(),
        })
    }
}
