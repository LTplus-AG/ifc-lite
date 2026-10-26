// SPDX-License-Identifier: MPL-2.0
//! Bounded diagnostic consumer. No numerical reply is accepted by this driver.
use super::*;
use crate::retained_inspection_contract as wire;
use crate::resource::{self, Cost, InspectionBudget, InspectionStart, OwnedResourceContext, ProgramStop, Reservation};
use std::io::Write;
use std::result::Result;

#[path = "inspection_origin.rs"]
mod origin;
#[path = "inspection_limits.rs"]
mod limits;

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
    pub fn bytes(&self) -> Result<&[u8], SourceInspectionError> {
        self.validate_delivery()?;
        Ok(&self.bytes)
    }
    /// Checks captured channels, even after unrelated ambient scopes are restored.
    pub fn validate_original_stop(&self) -> Result<(), ProgramStop> { self.resources.check() }
    /// Original monotonic deadline and stop domain, including after-scope delivery.
    pub fn validate_delivery(&self) -> Result<(), SourceInspectionError> {
        self.resources.with_scope(checkpoint)
    }
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
pub fn inspect_retained_program_source(
    element: &DecodedEntity,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
    binding_json: &str,
    source_epoch: u64,
    implementation_commit: &str,
) -> Result<SourceInspectionReport, SourceInspectionError> {
    let start = InspectionStart::now();
    checkpoint()?;
    if binding_json.len() > MAX_REPORT_BYTES { return Err(SourceInspectionError::InvalidReport); }
    let limits = limits::read(binding_json)?;
    checkpoint()?;
    let budget = InspectionBudget::new(start, limits.max_work, limits.max_bytes, limits.deadline_ms);
    budget.scope(|| {
        checkpoint()?;
        let _scratch = resource::charge(Cost { live_bytes: SCRATCH_BYTES, ..Default::default() })?;
        // Both the generated preflight and its owned String/Vec decode are
        // covered by admission. The bootstrap is not schema validation.
        let decoded = wire::decode_binding(binding_json);
        #[cfg(any(test, feature = "test-support"))]
        resource::inspection_test_clock::point("binding_decode");
        checkpoint()?;
        let binding = decoded.map_err(|_| SourceInspectionError::InvalidReport)?;
        inspect_binding(element, decoder, router, binding, source_epoch, implementation_commit)
    })
}

fn inspect_binding(element: &DecodedEntity, decoder: &mut EntityDecoder, router: &GeometryRouter,
    binding: wire::Binding, source_epoch: u64, implementation_commit: &str)
    -> Result<SourceInspectionReport, SourceInspectionError> {
    let resources = OwnedResourceContext::capture_current();
    let result = resources.with_scope(|| {
        checkpoint()?;
        if binding.requested.len() != 1 || binding.requested[0].product_id != element.id.to_string()
            || wire::text_format(implementation_commit, "commit").is_err() {
            return Err(SourceInspectionError::InvalidReport);
        }
        let outcome = drive(element, decoder, router, &binding, &resources, source_epoch);
        checkpoint()?;
        let report = wire::InspectionReport {
            schema_version: 1., kind: "source_inspection".into(), authority: "diagnostic_only".into(),
            identity: binding.identity.clone(), column: wire::Column::Controller,
            implementation_commit: implementation_commit.into(), product: binding.requested[0].clone(),
            outcome: outcome?, unchecked: unchecked(),
        };
        let valid = wire::validate_inspection(&report, &binding);
        checkpoint()?;
        valid.map_err(|_| SourceInspectionError::InvalidReport)?;
        let mut count = CountWriter(0);
        let counted = serde_json::to_writer(&mut count, &report);
        #[cfg(any(test, feature = "test-support"))]
        resource::inspection_test_clock::point("report_count");
        checkpoint()?;
        counted.map_err(|_| SourceInspectionError::InvalidReport)?;
        let mut bytes = Vec::new();
        let storage = resources.reserve_headers(&mut bytes, count.0)?;
        let written = serde_json::to_writer(BoundedWriter(&mut bytes), &report);
        #[cfg(any(test, feature = "test-support"))]
        resource::inspection_test_clock::point("report_write");
        checkpoint()?;
        written.map_err(|_| SourceInspectionError::InvalidReport)?;
        Ok(SourceInspectionReport { bytes, resources: resources.clone(), _storage: storage })
    });
    // Consult original channels after scope destruction, before accepting even
    // a source-refusal diagnostic. No foreign ambient state is consulted.
    resources.with_scope(checkpoint)?;
    result
}

fn checkpoint() -> Result<(), SourceInspectionError> {
    resource::inspection_checkpoint().map_err(|error| match error {
        crate::Error::ProgramStopped(ProgramStop::Cancelled) if resource::inspection_deadline_fired() =>
            SourceInspectionError::DeadlineExceeded,
        crate::Error::ProgramStopped(stop) => SourceInspectionError::Stopped(stop),
        _ => SourceInspectionError::InvalidReport,
    })
}

fn drive(element: &DecodedEntity, decoder: &mut EntityDecoder, router: &GeometryRouter,
    binding: &wire::Binding, resources: &OwnedResourceContext, source_epoch: u64)
    -> Result<wire::InspectionOutcome, SourceInspectionError> {
    let contract = RetainedContract {
        source_epoch, source_revision: binding.identity.source.revision.parse().map_err(|_| SourceInspectionError::InvalidReport)?,
    };
    let traversal = RetainedTraversal::new(contract);
    let mut program = traversal.product_parts(element);
    if program.unsupported { return Ok(origin::unavailable(binding)); }
    let limit: u64 = binding.identity.options.max_work.parse().map_err(|_| SourceInspectionError::InvalidReport)?;
    let mut ordinal = 0u64;
    loop {
        resources.check()?;
        checkpoint()?;
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
            Err(error) => return origin::outcome(reached_failure(&program, error), binding),
        };
        if ordinal >= limit {
            return Err(resource::refused(resource::Dimension::Work, 1, 0, resource::RefusalReason::Limit).into());
        }
        ordinal += 1;
        resource::charge(Cost { work: 1, ..Default::default() })?;
        let admitted = program.admit(ticket, router, decoder);
        #[cfg(any(test, feature = "test-support"))]
        resource::inspection_test_clock::point("admit");
        checkpoint()?;
        let (reply, operations) = match admitted {
            Ok(value) => value,
            Err(error) => return origin::outcome(reached_failure(&program, error), binding),
        };
        resources.check()?;
        checkpoint()?;
        if let Some(failure) = program.selection().and_then(|s| s.failure_handle().reported()) {
            return origin::outcome(failure, binding);
        }
        if !operations.is_empty() {
            // The owned reply has never been accepted. No outcome/receipt is
            // bound; later operands, roots and all product obligations are unknown.
            program.cancel();
            drop((reply, operations, program));
            return Ok(wire::InspectionOutcome::RequiresNumericalEvaluation(Box::new(wire::NumericalBoundary {
                stage: "numerical".into(), request_ordinal: ordinal.to_string(),
            })));
        }
        let accepted = program.accept(reply, router);
        checkpoint()?;
        if let Err(rejected) = accepted {
            return origin::outcome(reached_failure(&program, rejected.error), binding);
        }
    }
}

fn reached_failure(program: &RetainedProgram, error: RetainedProgramError) -> RetainedFailure {
    program.selection().and_then(|s| s.failure_handle().reported()).unwrap_or_else(|| error.into())
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
struct CountWriter(usize);
impl Write for CountWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_REPORT_BYTES.saturating_sub(self.0) {
            return Err(std::io::Error::other("inspection report bound"));
        }
        self.0 += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}
