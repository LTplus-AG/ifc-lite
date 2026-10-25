// SPDX-License-Identifier: MPL-2.0
//! Bounded diagnostic consumer. No numerical reply is accepted by this driver.
use super::*;
use crate::retained_inspection_contract as wire;
use crate::resource::{self, Cost, OwnedResourceContext, ProgramStop, Reservation};
use std::io::Write;
use std::result::Result;

#[path = "inspection_origin.rs"]
mod origin;

const MAX_REPORT_BYTES: usize = 16 * 1024;
// Covers bounded decoded binding/report trees and serialization scratch. This
// is requested backing accounting, not a global allocator/RSS guarantee.
const SCRATCH_BYTES: u64 = 256 * 1024;

/// Diagnostic bytes and their original stop domain; no source or execution lease.
/// Available only under `retained-runtime`, consumed by processing's census seam.
pub struct SourceInspectionReport {
    bytes: Vec<u8>,
    resources: OwnedResourceContext,
    _storage: Reservation,
}
impl SourceInspectionReport {
    /// Borrowing keeps the charged backing alive. Never a geometry certificate.
    pub fn bytes(&self) -> &[u8] { &self.bytes }
    /// Checks captured channels, even after unrelated ambient scopes are restored.
    pub fn validate_original_stop(&self) -> Result<(), ProgramStop> { self.resources.check() }
}

/// Failure to produce a bounded diagnostic. Source refusals use the strict report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceInspectionError {
    Stopped(ProgramStop),
    InvalidReport,
    DeadlineExceeded,
}
impl From<ProgramStop> for SourceInspectionError {
    fn from(stop: ProgramStop) -> Self { Self::Stopped(stop) }
}

/// Inspect one authenticated processing product root under its synchronous owner.
/// `binding_json` is a strict, source/options-bound A1s binding from processing;
/// it is descriptive input, never an owner capability. Direct callers must supply
/// their own source authentication. Controllers, recipes and tickets stay private.
pub fn inspect_retained_source(
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
    binding_json: &str,
    implementation_commit: &str,
) -> Result<SourceInspectionReport, SourceInspectionError> {
    let resources = OwnedResourceContext::capture_current();
    let result = resources.with_scope(|| {
        resources.check()?;
        let _scratch = resource::charge(Cost { live_bytes: SCRATCH_BYTES, ..Default::default() })?;
        if binding_json.len() > MAX_REPORT_BYTES {
            return Err(SourceInspectionError::InvalidReport);
        }
        let binding = wire::decode_binding(binding_json).map_err(|_| SourceInspectionError::InvalidReport)?;
        if binding.requested.len() != 1 || binding.requested[0].product_id != element.id.to_string()
            || wire::text_format(implementation_commit, "commit").is_err() {
            return Err(SourceInspectionError::InvalidReport);
        }
        let outcome = drive(element, decoder, router, &binding, &resources)?;
        resources.check()?;
        let report = wire::InspectionReport {
            schema_version: 1., kind: "source_inspection".into(), authority: "diagnostic_only".into(),
            identity: binding.identity.clone(), column: wire::Column::Controller,
            implementation_commit: implementation_commit.into(), product: binding.requested[0].clone(),
            outcome, unchecked: unchecked(),
        };
        wire::validate_inspection(&report, &binding).map_err(|_| SourceInspectionError::InvalidReport)?;
        let mut bytes = Vec::new();
        let storage = resources.reserve_headers(&mut bytes, MAX_REPORT_BYTES)?;
        serde_json::to_writer(BoundedWriter(&mut bytes), &report).map_err(|_| SourceInspectionError::InvalidReport)?;
        Ok(SourceInspectionReport { bytes, resources: resources.clone(), _storage: storage })
    });
    // Scope destruction can discover an original source/account stop.
    resources.check()?;
    result
}

fn drive(element: &DecodedEntity, decoder: &mut EntityDecoder, router: &GeometryRouter,
    binding: &wire::Binding, resources: &OwnedResourceContext)
    -> Result<wire::InspectionOutcome, SourceInspectionError> {
    let contract = RetainedContract {
        source_epoch: 0, source_revision: binding.identity.source.revision.parse().map_err(|_| SourceInspectionError::InvalidReport)?,
    };
    let traversal = RetainedTraversal::new(contract);
    let mut program = traversal.product_parts(element);
    let limit: u64 = binding.identity.options.max_work.parse().map_err(|_| SourceInspectionError::InvalidReport)?;
    let deadline: u64 = binding.identity.options.deadline_ms.parse().map_err(|_| SourceInspectionError::InvalidReport)?;
    let start = std::time::Instant::now();
    let mut ordinal = 0u64;
    loop {
        resources.check()?;
        if start.elapsed().as_millis() >= u128::from(deadline) {
            return Err(SourceInspectionError::DeadlineExceeded);
        }
        if let Some(failure) = program.selection().and_then(|s| s.failure_handle().reported()) {
            return origin::outcome(failure, binding);
        }
        let ticket = match program.request() {
            Ok(Some(ticket)) => ticket,
            Ok(None) => {
                // Inspect the source terminal error only. Never construct or
                // finish a RetainedProductPlan, including an empty removal plan.
                let failure = program.selection().map(RetainedSelection::failure_handle);
                return match program.inner.finish_output() {
                    Ok(_) => Ok(wire::InspectionOutcome::TraversalOnly(Box::new(wire::TraversalOnly {}))),
                    Err(error) => match failure {
                        Some(handle) => origin::outcome(handle.common(FailureSite::ProductCompletion, error), binding),
                        None => origin::outcome(RetainedProgramError::Unsupported.into(), binding),
                    },
                };
            }
            Err(error) => return origin::outcome(error.into(), binding),
        };
        if ordinal >= limit {
            return Err(resource::refused(resource::Dimension::Work, 1, 0, resource::RefusalReason::Limit).into());
        }
        ordinal += 1;
        resource::charge(Cost { work: 1, ..Default::default() })?;
        let (reply, operations) = match program.admit(ticket, router, decoder) {
            Ok(value) => value,
            Err(error) => return origin::outcome(error.into(), binding),
        };
        resources.check()?;
        if !operations.is_empty() {
            // The owned reply has never been accepted. No outcome/receipt is
            // bound; later operands, roots and all product obligations are unknown.
            program.cancel();
            drop((reply, operations, program));
            return Ok(wire::InspectionOutcome::RequiresNumericalEvaluation(Box::new(wire::NumericalBoundary {
                stage: "numerical".into(), request_ordinal: ordinal.to_string(),
            })));
        }
        if let Err(rejected) = program.accept(reply, router) {
            return origin::outcome(rejected.error.into(), binding);
        }
    }
}

fn unchecked() -> wire::Requirements {
    use wire::Requirement::*;
    vec![Representation, NumericalEvaluation, Openings, Layers, Interfaces, Textures, Palettes,
        Normals, FaceIdentity, Instancing, FinalGeometry, ProtectedRemoval, Publication]
}
struct BoundedWriter<'a>(&'a mut Vec<u8>);
impl Write for BoundedWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_REPORT_BYTES.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other("inspection report bound"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}
