// SPDX-License-Identifier: MPL-2.0
//! Actual native consumer. Intermediate evidence only; no geometry leaves here.
use super::*;
use sha2::{Digest, Sha256};
use std::path::Path;
use ifc_lite_core::SourceBundle;

#[derive(Debug)]
pub struct NativeDiagnosticError(RetainedExecutionError);
impl NativeDiagnosticError {
    pub fn diagnostic_code_json(&self) -> String {
        serde_json::to_string(&self.0.code()).expect("finite generated diagnostic code")
    }
}
impl std::fmt::Display for NativeDiagnosticError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.diagnostic_code_json())
    }
}
impl std::error::Error for NativeDiagnosticError {}
impl From<RetainedExecutionError> for NativeDiagnosticError {
    fn from(error: RetainedExecutionError) -> Self { Self(error) }
}

/// Owns the live intermediate witness and bounded diagnostic bytes. No mesh,
/// removal authority, raw object handle or final definition can be extracted.
pub struct NativeTransactionDiagnostic {
    witness: RuntimeProductWitness<RealizationKind>,
    _worker: Option<SmlibWorker>,
    _snapshot: Arc<OwnedMeshProductionContext>,
    bytes: Vec<u8>,
    _storage: Storage,
}
impl NativeTransactionDiagnostic {
    pub fn bytes(&self) -> Result<&[u8], NativeDiagnosticError> {
        self.witness.validate()?;
        Ok(&self.bytes)
    }
    pub fn require_final_product(&self) -> Result<(), NativeDiagnosticError> {
        self.witness.require_final_product().map_err(Into::into)
    }
}

/// Development diagnostic for a real source product and an existing private
/// SMLib process. Does not install, link, publish, or locate SDK assets.
pub async fn diagnose_retained_native(source: Arc<SourceBundle>, product_id: u32,
    worker_path: &Path, chord_metres: f64, angle_degrees: f64, max_bytes: usize,
    max_work: u64, type_geometry_mode: TypeGeometryMode) -> Result<NativeTransactionDiagnostic, NativeDiagnosticError> {
    IssuedCommonConstruction::validate_numerical_limits(chord_metres, angle_degrees, max_bytes)?;
    let account = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(resource::ResourceLimits {
        live_bytes: Some(max_bytes as u64), work: Some(max_work), ..Default::default()
    }));
    let model = ProductionModel::from_source(source.clone());
    let snapshot = model.snapshot(Default::default());
    let mut decoder = source.decoder();
    let prepared = account.scope(|| diagnostic_source::prepare(
        &source, &snapshot, &mut decoder, product_id, type_geometry_mode))?;
    let router = prepared.router;
    let entity = prepared.entity;
    let job = ElementMeshJob { id: product_id, ifc_type: entity.ifc_type.clone(),
        entity: &entity, kind: prepared.kind, element_color: None, metadata: None };
    let mut execution = account.scope(|| RetainedProductExecution::begin(
        &job, &snapshot, &MeshProductionOptions::default(), &mut decoder, &router))?;
    let mut worker = None;
    let limits = runtime::NumericalLimits { chord_metres, angle_degrees, max_bytes };
    while execution.advance_source(&mut decoder, &router)? {
        let worker = match &mut worker {
            Some(worker) => worker,
            slot @ None => slot.insert(SmlibWorker::spawn(worker_path).map_err(RetainedExecutionError::Runtime)?),
        };
        let issued = execution.issue_next(&mut decoder, &router, worker)?
            .ok_or_else(|| protocol(ReceiptFailure::MissingAdmission))?;
        let completed = issued.execute_async(worker, limits).await.map_err(|e| NativeDiagnosticError(e.reason))?;
        execution.accept(completed, &mut decoder, &router).map_err(|rejected| {
            let RuntimeRejectedCompletion { reason, work } = *rejected;
            // This diagnostic ends the attempt; the private controller API
            // returned the intact packet for callers that correct their fault.
            drop(work);
            NativeDiagnosticError(reason)
        })?;
    }
    let witness = execution.into_witness()?;
    // Refusal is the contract even after every numerical operation succeeded.
    witness.require_final_product().expect_err("intermediate witness cannot grant final authority");
    let resources = witness.resources.clone();
    let mut storage = Storage::default();
    storage.charge(&resources, resource::Cost { live_bytes: 8192, ..Default::default() })?;
    let bytes = resources.with_scope(|| {
        let report = serde_json::json!({
            "schemaVersion": 1, "status": "intermediate_numerical_diagnostic",
            "productId": product_id.to_string(),
            "sourceSha256": format!("{:x}", Sha256::digest(source.bytes())),
            "sourceRevision": snapshot.lifecycle().epoch_revision().1.to_string(),
            "dischargedOperations": witness.discharged_count().to_string(),
            "logicalValues": witness.plan().values().len().to_string(),
            "sourceBindingCount": witness.plan().values().map(|v| v.bindings().count()).sum::<usize>().to_string(),
            "finalProductAvailable": false,
            "unchecked": ["opening_closure", "material_layers", "ifc_appearance", "persistent_faces"],
            "typePlacementUnchecked": witness.plan().requirements().any(|r| r == RetainedRequirement::ProductPlacement),
        });
        serde_json::to_vec(&report).map_err(|_| protocol(ReceiptFailure::DiagnosticSerialization))
    })?;
    witness.validate()?;
    Ok(NativeTransactionDiagnostic { witness, _worker: worker, _snapshot: snapshot, bytes, _storage: storage })
}

#[cfg(test)]
#[path = "diagnostic_tests.rs"]
mod tests;
