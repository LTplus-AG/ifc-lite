// SPDX-License-Identifier: MPL-2.0
use super::*;
/// Owned intermediate evidence. This deliberately exposes no final mesh/product.
pub struct RuntimeProductWitness<R: NumericalReceipt> {
    plan: RetainedProductPlan,
    layer_manifest: Option<DerivedLayerManifest<R>>,
    layer_source: Option<Arc<RetainedLayerSource>>,
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
        if let Some(manifest) = &self.layer_manifest { manifest.validate()?; }
        Ok(())
    }
    /// Intermediate evidence never grants final-product publication authority.
    pub fn require_final_product(&self) -> Result<(), RetainedExecutionError> {
        self.validate()?;
        Err(RetainedExecutionError::Unsupported(
            "retained final publication requires opening/layer/appearance/face proofs"))
    }
    /// Source-bound unresolved J3 bands; no cut or partition proof is implied.
    pub fn layer_source(&self) -> Option<&RetainedLayerSource> { self.layer_source.as_deref() }
    pub fn layer_manifest(&self) -> Option<&DerivedLayerManifest<R>> { self.layer_manifest.as_ref() }
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
        if self.layer_manifest.is_some() { self.layer_token = None; }
        Ok(RuntimeProductWitness {
            plan,
            layer_manifest: self.layer_manifest.take(),
            layer_source: self.layer_source.take(),
            ledger: std::mem::take(&mut self.ledger),
            _permits: std::mem::take(&mut self.permits),
            lifecycle: self.context.lifecycle(),
            resources: self.resources.clone(),
        })
    }
}
