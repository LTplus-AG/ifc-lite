// SPDX-License-Identifier: MPL-2.0
use super::*;
/// Owned intermediate evidence. This deliberately exposes no final mesh/product.
pub(super) struct RuntimeProductWitness<R: NumericalReceipt> {
    plan: RetainedProductPlan,
    ledger: Vec<(LogicalRetainedValue, Arc<RuntimeRealization<R>>)>,
    lifecycle: ProductionLifecycle,
    pub(super) resources: OwnedResourceContext,
    _permits: Storage,
}
impl<R: NumericalReceipt> RuntimeProductWitness<R> {
    pub(super) fn validate(&self) -> Result<(), RetainedExecutionError> {
        self.resources
            .check()
            .map_err(RetainedExecutionError::Stopped)?;
        self.lifecycle
            .validate()
            .map_err(RetainedExecutionError::Source)?;
        for (_, realization) in &self.ledger {
            realization.validate_live().map_err(protocol)?;
        }
        Ok(())
    }
    /// Intermediate evidence never grants final-product publication authority.
    pub(super) fn require_final_product(&self) -> Result<(), RetainedExecutionError> {
        self.validate()?;
        Err(RetainedExecutionError::Unsupported(Unsupported::RetainedFinalPublicationRequiresOpeningLayerAppearanceFaceProofs))
    }
    pub(super) fn plan(&self) -> &RetainedProductPlan {
        &self.plan
    }
    pub(super) fn discharged_count(&self) -> usize {
        self.ledger.len()
    }
}
impl<R: NumericalReceipt> RuntimeProductExecution<'_, R> {
    pub(super) fn into_witness(mut self) -> Result<RuntimeProductWitness<R>, RetainedExecutionError> {
        self.validate_witness()?;
        let plan = self
            .plan
            .take()
            .ok_or_else(|| protocol(ReceiptFailure::UnfinishedProduct))?;
        Ok(RuntimeProductWitness {
            plan,
            ledger: std::mem::take(&mut self.ledger),
            _permits: std::mem::take(&mut self.permits),
            lifecycle: self.context.lifecycle(),
            resources: self.resources.clone(),
        })
    }
}
