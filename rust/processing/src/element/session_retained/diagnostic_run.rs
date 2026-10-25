// SPDX-License-Identifier: MPL-2.0
//! Source-owned diagnostic drive over the private runtime seam. No final geometry.
use super::*;
use diagnostic_report::{ReportBytes, ReportContext};
use ifc_lite_core::SourceBundle;
use runtime::{AsyncRetainedExecutor, NumericalLimits};

pub(super) struct DiagnosticFailure {
    pub(super) cause: RetainedExecutionError,
    pub(super) report: Option<ReportBytes>,
    pub(super) report_failure: Option<crate::retained_native_contract::Code>,
}
impl DiagnosticFailure {
    fn bound(cause: RetainedExecutionError, context: ReportContext) -> Self {
        match context.refused(&cause) {
            Ok(report) => Self { cause, report: Some(report), report_failure: None },
            Err(report_failure) => Self { cause, report: None, report_failure: Some(report_failure.code()) },
        }
    }
}
impl From<RetainedExecutionError> for DiagnosticFailure {
    fn from(cause: RetainedExecutionError) -> Self { Self { cause, report: None, report_failure: None } }
}

pub(super) struct RuntimeDiagnostic<W: RetainedRuntime> {
    pub(super) witness: RuntimeProductWitness<W::Receipt>,
    pub(super) worker: Option<W>,
    pub(super) snapshot: Arc<OwnedMeshProductionContext>,
    pub(super) report: ReportBytes,
}

// Only the concrete native entry calls this private seam today. Acquiring a
// backend never bypasses source admission or supplies caller-created receipts.
pub(super) async fn run<W: AsyncRetainedExecutor>(source: Arc<SourceBundle>, product_id: u32,
    options_json: &str, implementation_commit: &str,
    acquire: impl FnMut() -> Result<W, RetainedExecutionError>)
    -> Result<RuntimeDiagnostic<W>, DiagnosticFailure> {
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
    let execution = options.budget.scope(|| RuntimeProductExecution::<W::Receipt>::begin(
        &job, &snapshot, &MeshProductionOptions::default(), &mut decoder, &router))?;
    let report = ReportContext::new(&source, &entity, snapshot.lifecycle().epoch_revision().1,
        &options.wire, implementation_commit, execution.resources.clone())?;
    let (witness, worker) = match drive(execution, &mut decoder, &router, acquire, options.limits).await {
        Ok(completed) => completed,
        Err(error) => return Err(DiagnosticFailure::bound(error, report)),
    };
    let report = report.intermediate(&witness)?;
    witness.validate()?;
    Ok(RuntimeDiagnostic { witness, worker, snapshot, report })
}

async fn drive<W: AsyncRetainedExecutor>(mut execution: RuntimeProductExecution<'_, W::Receipt>,
    decoder: &mut EntityDecoder<'_>, router: &GeometryRouter,
    mut acquire: impl FnMut() -> Result<W, RetainedExecutionError>, limits: NumericalLimits)
    -> Result<(RuntimeProductWitness<W::Receipt>, Option<W>), RetainedExecutionError> {
    let mut worker = None;
    while execution.advance_source(decoder, router)? {
        let worker = match &mut worker {
            Some(worker) => worker,
            slot @ None => slot.insert(acquire()?),
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
