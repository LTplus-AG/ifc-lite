// SPDX-License-Identifier: MPL-2.0
//! Actual native consumer. Intermediate evidence only; no geometry leaves here.
use super::*;
use std::path::Path;
use ifc_lite_core::SourceBundle;
use diagnostic_report::{ReportBytes, ReportContext};

/// An entry failure may precede authenticated identity. Only `report_bytes`
/// supplies a bound generated refusal; Display is ordinary error prose.
pub struct NativeDiagnosticError {
    cause: RetainedExecutionError,
    report: Option<ReportBytes>,
    report_failure: Option<crate::retained_native_contract::Code>,
}
impl NativeDiagnosticError {
    pub fn report_bytes(&self) -> Option<&[u8]> { self.report.as_ref().map(|report| report.bytes.as_slice()) }
    fn bound(cause: RetainedExecutionError, context: ReportContext) -> Self {
        match context.refused(&cause) {
            Ok(report) => Self { cause, report: Some(report), report_failure: None },
            Err(report_failure) => Self { cause, report: None, report_failure: Some(report_failure.code()) },
        }
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
    let options = diagnostic_options::Options::decode(options_json)?;
    crate::retained_native_contract::text_format(implementation_commit, "commit")
        .map_err(|_| protocol(ReceiptFailure::InvalidRetainedNumericalLimits))?;
    let model = ProductionModel::from_source(source.clone());
    let snapshot = model.snapshot(Default::default());
    let mut decoder = source.decoder();
    let prepared = options.budget.scope(|| diagnostic_source::prepare(
        &source, &snapshot, &mut decoder, product_id, options.mode))?;
    let router = prepared.router;
    let entity = prepared.entity;
    let job = ElementMeshJob { id: product_id, ifc_type: entity.ifc_type.clone(),
        entity: &entity, kind: prepared.kind, element_color: None, metadata: None };
    let execution = options.budget.scope(|| RetainedProductExecution::begin(
        &job, &snapshot, &MeshProductionOptions::default(), &mut decoder, &router))?;
    let report = ReportContext::new(&source, &entity, snapshot.lifecycle().epoch_revision().1,
        &options.wire, implementation_commit, execution.resources.clone())?;
    let (witness, worker) = match drive(execution, &mut decoder, &router, worker_path, options.limits).await {
        Ok(completed) => completed,
        Err(error) => return Err(NativeDiagnosticError::bound(error, report)),
    };
    let report = report.intermediate(&witness)?;
    witness.validate()?;
    Ok(NativeTransactionDiagnostic { witness, _worker: worker, _snapshot: snapshot, report })
}
async fn drive(mut execution: RetainedProductExecution<'_>, decoder: &mut EntityDecoder<'_>,
    router: &GeometryRouter, worker_path: &Path, limits: runtime::NumericalLimits)
    -> Result<(RuntimeProductWitness<RealizationKind>, Option<SmlibWorker>), RetainedExecutionError> {
    let mut worker = None;
    while execution.advance_source(decoder, router)? {
        let worker = match &mut worker {
            Some(worker) => worker,
            slot @ None => slot.insert(SmlibWorker::spawn(worker_path).map_err(RetainedExecutionError::Runtime)?),
        };
        let issued = execution.issue_next(decoder, router, worker)?
            .ok_or_else(|| protocol(ReceiptFailure::MissingAdmission))?;
        let completed = issued.execute_async(worker, limits).await.map_err(|error| error.reason)?;
        execution.accept(completed, decoder, router).map_err(|rejected| {
            let RuntimeRejectedCompletion { reason, work } = *rejected;
            // The entry ends this attempt; the private controller returned the
            // intact packet for callers that correct a recoverable caller fault.
            drop(work);
            reason
        })?;
    }
    let witness = execution.into_witness()?;
    witness.require_final_product().expect_err("intermediate evidence cannot grant final authority");
    Ok((witness, worker))
}

#[cfg(test)]
#[path = "diagnostic_tests.rs"]
mod tests;
