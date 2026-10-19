// SPDX-License-Identifier: MPL-2.0
//! Model-owned authored admission. Standalone public plans never acquire this
//! authority by supplying matching bytes, keys, epochs or revision integers.
use super::{evaluator::AuthoredRetainedDocument, AuthoredGeometryPlan};
use crate::{element::{OwnedMeshProductionContext, ProductionLifecycle}, AnalyticSourceKey};
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::document::{EvaluationContract, RetainedRefusal, RetainedRequest};
use std::sync::Arc;

/// Immutable source analysis under one production snapshot and actual decoder binding.
/// There is no public constructor from a caller-editable plan.
pub struct BoundAuthoredPlan {
    plan: AuthoredGeometryPlan,
    lifecycle: ProductionLifecycle,
}

impl OwnedMeshProductionContext {
    /// Validate the actual source owner before touching IFC. The canonical
    /// source index, trusted input policy and warm decoder caches are reused.
    /// Repeated admission reuses live analysis only for this actual decoder/input
    /// generation. Different healthy workers preserve their own cache selections.
    pub fn admit_authored_plan(&self, decoder: &mut EntityDecoder<'_>)
        -> Result<Arc<BoundAuthoredPlan>, RetainedRefusal>
    {
        self.validate_decoder(decoder).map_err(source_error)?;
        let source = self.source().ok_or(RetainedRefusal::InvalidSource("authenticated source bundle required"))?;
        let _lease = decoder.try_execution_lease()
            .map_err(|_| RetainedRefusal::InvalidSource("authored source decoder busy"))?;
        let binding = decoder.execution_identity();
        let cached = {
            let mut cache = self.authored_cache().lock()
                .map_err(|_| RetainedRefusal::InvalidSource("authored binding cache poisoned"))?;
            cache.retain(|_, plan| plan.strong_count() != 0);
            cache.get(&binding).and_then(std::sync::Weak::upgrade)
        };
        if let Some(plan) = cached {
            self.validate_decoder(decoder).map_err(source_error)?;
            return Ok(plan);
        }
        // No cache mutex spans IFC interpretation or decoder work. The lease
        // keeps this actual binding exclusive while lazy memoization proceeds.
        let plan = Arc::new(BoundAuthoredPlan {
            plan: super::planning::plan_decoder(decoder, source.bytes()), lifecycle: self.lifecycle(),
        });
        self.validate_decoder(decoder).map_err(source_error)?;
        if decoder.execution_identity() != binding {
            return Err(RetainedRefusal::InvalidSource("decoder binding changed during authored analysis"));
        }
        let mut cache = self.authored_cache().lock()
            .map_err(|_| RetainedRefusal::InvalidSource("authored binding cache poisoned"))?;
        cache.retain(|_, plan| plan.strong_count() != 0);
        cache.insert(binding, Arc::downgrade(&plan));
        Ok(plan)
    }
}

impl BoundAuthoredPlan {
    /// Read-only inspection is not a transferable admission capability.
    pub fn plan(&self) -> &AuthoredGeometryPlan { &self.plan }

    pub fn admit_source(&self, key: &AnalyticSourceKey)
        -> Result<ModelBoundRetainedDocument, RetainedRefusal>
    {
        self.lifecycle.validate().map_err(source_error)?;
        let (epoch, revision) = self.lifecycle.epoch_revision();
        let document = AuthoredRetainedDocument::admit_source(&self.plan, key, epoch, revision)?;
        self.lifecycle.validate().map_err(source_error)?;
        Ok(ModelBoundRetainedDocument { document, lifecycle: self.lifecycle.clone(), pending: None })
    }
}

/// Numerical recipe/document ownership retains only the small revision state.
/// No SourceBundle, decoder, bytes or appearance maps survive in this owner.
pub struct ModelBoundRetainedDocument {
    pub(super) document: AuthoredRetainedDocument,
    pub(super) lifecycle: ProductionLifecycle,
    pub(super) pending: Option<std::sync::Weak<()>>,
}
impl ModelBoundRetainedDocument {
    /// This request remains decoder-free. Runtime acceptance additionally needs
    /// an executor-issued receipt; host-created completions are not accepted here.
    pub fn prepare(&self, key: &AnalyticSourceKey, contract: EvaluationContract, incarnation: u64)
        -> Result<RetainedRequest, RetainedRefusal>
    {
        self.lifecycle.validate().map_err(source_error)?;
        self.document.prepare(key, contract, incarnation)
    }
    pub fn document(&self) -> &ifc_lite_geometry::document::GeometryDocument {
        self.document.document()
    }
}

pub(super) fn source_error(_: crate::element::ProductionContextError) -> RetainedRefusal {
    RetainedRefusal::InvalidSource("production source expired or decoder mismatched")
}
