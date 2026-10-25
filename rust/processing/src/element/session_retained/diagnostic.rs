// SPDX-License-Identifier: MPL-2.0
//! Actual native consumer. Intermediate evidence only; no geometry leaves here.
use super::*;
use std::path::Path;
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry_runtime::SmlibWorker;
use diagnostic_report::ReportBytes;
use diagnostic_run::{DiagnosticFailure, RuntimeDiagnostic};
use native_types::RealizationKind;

/// An entry failure may precede authenticated identity. Only `report_bytes`
/// supplies a bound generated refusal; Display is ordinary error prose.
pub struct NativeDiagnosticError {
    cause: RetainedExecutionError,
    report: Option<ReportBytes>,
    report_failure: Option<crate::retained_native_contract::Code>,
}
impl NativeDiagnosticError {
    pub fn report_bytes(&self) -> Option<&[u8]> { self.report.as_ref().map(|report| report.bytes.as_slice()) }
    fn from_failure(failure: DiagnosticFailure) -> Self {
        let DiagnosticFailure { cause, report, report_failure } = failure;
        Self { cause, report, report_failure }
    }
}
impl std::fmt::Debug for NativeDiagnosticError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeDiagnosticError").field("cause", &self.cause)
            .field("report_failure", &self.report_failure).finish()
    }
}
impl std::fmt::Display for NativeDiagnosticError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "native diagnostic refused: {}", self.cause)?;
        if let Some(error) = &self.report_failure { write!(f, "; bound report unavailable: {error:?}")?; }
        Ok(())
    }
}
impl std::error::Error for NativeDiagnosticError {}
impl From<RetainedExecutionError> for NativeDiagnosticError {
    fn from(cause: RetainedExecutionError) -> Self { Self { cause, report: None, report_failure: None } }
}

/// Owns the live intermediate witness and bounded generated diagnostic bytes.
/// No mesh, removal authority, object handle or final definition is exposed.
pub struct NativeTransactionDiagnostic {
    witness: RuntimeProductWitness<RealizationKind>,
    _worker: Option<SmlibWorker>,
    _snapshot: Arc<OwnedMeshProductionContext>,
    report: ReportBytes,
}
impl NativeTransactionDiagnostic {
    pub fn bytes(&self) -> Result<&[u8], NativeDiagnosticError> {
        self.witness.validate()?;
        Ok(&self.report.bytes)
    }
    pub fn require_final_product(&self) -> Result<(), NativeDiagnosticError> {
        self.witness.require_final_product().map_err(Into::into)
    }
}

/// Development diagnostic over the strict private options contract and a real
/// source product/type. The source-pinned caller supplies its implementation SHA.
/// This never installs, links, publishes, or locates SDK assets.
pub async fn diagnose_retained_native(source: Arc<SourceBundle>, product_id: u32,
    worker_path: &Path, options_json: &str, implementation_commit: &str)
    -> Result<NativeTransactionDiagnostic, NativeDiagnosticError> {
    let RuntimeDiagnostic { witness, worker, snapshot, report } = diagnostic_run::run(
        source, product_id, options_json, implementation_commit,
        || SmlibWorker::spawn(worker_path).map_err(RetainedExecutionError::Runtime))
        .await.map_err(NativeDiagnosticError::from_failure)?;
    Ok(NativeTransactionDiagnostic { witness, _worker: worker, _snapshot: snapshot, report })
}

#[cfg(test)]
#[path = "diagnostic_tests.rs"]
mod tests;
