// SPDX-License-Identifier: MPL-2.0
//! Source-only admission through the same product controller as retained execution.
use super::refusal::RetainedProductRefusal;
use super::runtime::{ReceiptEvidence, RuntimeFault};
use super::*;

#[derive(Debug)]
pub struct RetainedAdmissionError(RetainedProductRefusal);
impl RetainedAdmissionError {
    pub fn refusal(&self) -> RetainedProductRefusal {
        self.0
    }
}

/// Admit source traversal up to its first numerical operation, without execution.
/// D's whole-model driver supersedes this temporary admission entry (Refs #7955).
#[doc(hidden)]
pub fn admit_product(
    source: Arc<ifc_lite_core::SourceBundle>,
    decoder: &mut EntityDecoder<'_>,
    product_id: u32,
) -> Result<(), RetainedAdmissionError> {
    admit(source, decoder, product_id).map_err(|error| RetainedAdmissionError(error.refusal().0))
}

fn admit(
    source: Arc<ifc_lite_core::SourceBundle>,
    decoder: &mut EntityDecoder<'_>,
    product_id: u32,
) -> Result<(), RetainedExecutionError> {
    if !source.owns_decoder(decoder) {
        return Err(RetainedExecutionError::Source(
            RetainedContextError::Mismatched,
        ));
    }
    let mut spans = crate::prepass::PrepassSpans::default();
    let mut scanner = ifc_lite_core::EntityScanner::new(source.bytes());
    while let Some((id, name, start, end)) = scanner.next_entity() {
        error::budget_checkpoint()?;
        spans.stash(name, id, start, end);
    }
    let resolved = crate::prepass::resolve_prepass(&spans, decoder, Default::default());
    let mut router = GeometryRouter::with_units(source.bytes(), decoder);
    router.set_material_layer_index(Arc::new(
        ifc_lite_geometry::MaterialLayerIndex::from_content(source.bytes(), decoder),
    ));
    let context = ProductionModel::from_source(source.clone()).snapshot(OwnedMeshProductionData {
        void_index: Arc::new(resolved.void_index),
        ..Default::default()
    });
    let entity = decoder
        .decode_by_id(product_id)
        .map_err(RetainedExecutionError::Core)?;
    let job = ElementMeshJob {
        id: product_id,
        ifc_type: entity.ifc_type.clone(),
        entity: &entity,
        kind: ElementJobKind::Product,
        element_color: None,
        metadata: None,
    };
    let mut execution = RuntimeProductExecution::<AdmissionOnly>::begin(
        &job,
        &context,
        &MeshProductionOptions::default(),
        decoder,
        &router,
    )?;
    execution.advance_source(decoder, &router)?;
    Ok(())
}

// Uninhabited: this source-only entry cannot construct a numerical receipt or domain.
#[derive(Clone, Copy)]
enum AdmissionOnly {}
impl ReceiptDomain for AdmissionOnly {
    fn incarnation(&self) -> Option<u64> {
        match *self {}
    }
    fn retire(&self) {
        match *self {}
    }
    fn same_domain(&self, _: &Self) -> bool {
        match *self {}
    }
}
impl NumericalReceipt for AdmissionOnly {
    type Object = ();
    type Domain = Self;
    type Error = RuntimeFault;
    fn heap_bytes() -> u64 {
        0
    }
    fn buffer_bytes(&self) -> Result<u64, RuntimeFault> {
        match *self {}
    }
    fn object(&self) {
        match *self {}
    }
    fn evidence(&self) -> ReceiptEvidence<'_, ()> {
        match *self {}
    }
    fn domain(&self) -> &Self {
        match *self {}
    }
    fn validate_live(&self) -> Result<(), RuntimeFault> {
        match *self {}
    }
}
