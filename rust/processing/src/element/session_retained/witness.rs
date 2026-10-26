// SPDX-License-Identifier: MPL-2.0
use super::*;
/// Owned intermediate evidence. This deliberately exposes no final mesh/product.
pub struct RuntimeProductWitness<R: NumericalReceipt> {
    pub(super) plan: RetainedProductPlan,
    pub(super) product_id: u32,
    pub(super) ifc_type: IfcType,
    pub(super) ledger: Vec<(LogicalRetainedValue, Arc<RuntimeRealization<R>>)>,
    lifecycle: ProductionLifecycle,
    pub(super) resources: OwnedResourceContext,
    _permits: Storage,
}
impl<R: NumericalReceipt> RuntimeProductWitness<R> {
    pub fn validate(&self) -> Result<(), RetainedExecutionError> {
        check_resources(&self.resources)?;
        self.lifecycle
            .validate()
            .map_err(RetainedExecutionError::Source)?;
        for (_, realization) in &self.ledger {
            realization.validate_live().map_err(runtime_fault)?;
        }
        Ok(())
    }
    /// Intermediate evidence never grants final-product publication authority.
    pub fn require_final_product(&self) -> Result<(), RetainedExecutionError> {
        self.validate()?;
        Err(RetainedExecutionError::Unsupported(
            Unsupported::RetainedFinalPublicationRequiresOpeningLayerAppearanceFaceProofs,
        ))
    }
    pub fn plan(&self) -> &RetainedProductPlan {
        &self.plan
    }
    pub fn discharged_count(&self) -> usize {
        self.ledger.len()
    }
}
impl<R: NumericalReceipt> RuntimeProductExecution<'_, R> {
    pub(super) fn into_witness(
        mut self,
    ) -> Result<RuntimeProductWitness<R>, RetainedExecutionError> {
        self.validate_witness()?;
        let plan = self
            .plan
            .take()
            .ok_or_else(|| protocol(ReceiptFailure::UnfinishedProduct))?;
        Ok(RuntimeProductWitness {
            plan,
            product_id: self.state.job.id,
            ifc_type: self.state.job.ifc_type.clone(),
            ledger: std::mem::take(&mut self.ledger),
            _permits: std::mem::take(&mut self.permits),
            lifecycle: self.context.lifecycle(),
            resources: self.resources.clone(),
        })
    }
}
