// SPDX-License-Identifier: MPL-2.0
//! Bound, generated native report; raw stops are never invented measurements.
use super::*;
use crate::retained_native_contract as wire;
use ifc_lite_core::{SourceBundle, AttributeValue, slot};
use sha2::{Digest, Sha256};

pub(super) struct ReportContext {
    binding: wire::Binding,
    implementation_commit: String,
    resources: OwnedResourceContext,
    storage: Storage,
    type_product: bool,
}
pub(super) struct ReportBytes { pub(super) bytes: Vec<u8>, pub(super) _storage: Storage }
impl ReportContext {
    pub(super) fn new(source: &SourceBundle, root: &DecodedEntity, revision: u64,
        options: &wire::Options, implementation_commit: &str, resources: OwnedResourceContext)
        -> Result<Self, RetainedExecutionError> {
        let mut storage = Storage::default();
        // Bounded scalar contract: no source prose or variable-length report lists.
        // Admit construction, serialization and strict decode before source work.
        storage.charge(&resources, resource::Cost { live_bytes: 64 * 1024, ..Default::default() })?;
        let global_id = match root.attr(slot::IfcRoot::GLOBAL_ID) {
            None | Some(AttributeValue::Null) => wire::GlobalIdentity::Absent(Box::new(wire::AbsentGlobalId {})),
            Some(value) => {
                let value = value.as_string().ok_or(RetainedExecutionError::InvalidTypeSource)?;
                wire::check_global_id(value).map_err(|_| RetainedExecutionError::InvalidTypeSource)?;
                wire::GlobalIdentity::Known(Box::new(wire::KnownGlobalId { value: value.into() }))
            }
        };
        let mut hash = Sha256::new();
        for bytes in source.bytes().chunks(64 * 1024) {
            check_resources(&resources)?;
            resources.with_scope(|| resource::charge(resource::Cost { work: 1, ..Default::default() }))
                .map_err(RetainedExecutionError::Stopped)?.retain();
            hash.update(bytes);
        }
        let sha256 = format!("{:x}", hash.finalize());
        let namespace = format!("{:x}", Sha256::digest(format!("ifc-lite/native-transaction/v1/{sha256}")));
        let source = wire::Source { namespace, sha256, revision: revision.to_string() };
        let canonical = serde_json::to_vec(&(&source, options)).map_err(|_| protocol(ReceiptFailure::DiagnosticSerialization))?;
        let result_id = format!("{:x}", Sha256::digest(canonical));
        let binding = wire::Binding {
            identity: wire::Identity { schema_version: 1., coverage_version: 1., engine: "retained".into(),
                source, options: options.clone(), result_id },
            enumeration_complete: false, non_geometric: Vec::new(),
            requested: vec![wire::ProductKey { product_id: root.id.to_string(), global_id }],
        };
        Ok(Self { binding, resources, storage, implementation_commit: implementation_commit.into(),
            type_product: root.ifc_type.is_subtype_of(IfcType::IfcTypeProduct) })
    }
    pub(super) fn intermediate<R: NumericalReceipt>(self, witness: &RuntimeProductWitness<R>)
        -> Result<ReportBytes, RetainedExecutionError> {
        witness.validate()?;
        let outcome = wire::NativeOutcome::Intermediate(Box::new(wire::NativeIntermediate {
            discharged_operations: witness.discharged_count().to_string(),
            logical_values: witness.plan().values().len().to_string(),
            source_binding_count: witness.plan().values().map(|value| value.bindings().count()).sum::<usize>().to_string(),
        }));
        let mut unchecked = vec![wire::NativeObligation::FinalGeometry,
            wire::NativeObligation::ProtectedRemoval, wire::NativeObligation::Publication];
        for requirement in witness.plan().requirements() {
            unchecked.push(match requirement {
                RetainedRequirement::ProductPlacement => wire::NativeObligation::ProductPlacement,
                RetainedRequirement::OpeningClosure => wire::NativeObligation::OpeningClosure,
                RetainedRequirement::MaterialLayers => wire::NativeObligation::MaterialLayers,
                RetainedRequirement::IfcAppearance => wire::NativeObligation::IfcAppearance,
                RetainedRequirement::PersistentFaces => wire::NativeObligation::PersistentFaces,
            });
        }
        self.encode(outcome, Some(unchecked))
    }
    pub(super) fn refused(self, error: &RetainedExecutionError) -> Result<ReportBytes, RetainedExecutionError> {
        // Storage was reserved before the terminal event. Do not reacquire or
        // invent resource permission in the already stopped execution domain.
        self.encode(wire::NativeOutcome::Refused(Box::new(wire::NativeRefused { refusal: failure(error) })), None)
    }
    fn encode(self, outcome: wire::NativeOutcome, obligations: Option<Vec<wire::NativeObligation>>)
        -> Result<ReportBytes, RetainedExecutionError> {
        use wire::NativeObligation as Obligation;
        let mut unchecked = vec![Obligation::OpeningClosure, Obligation::MaterialLayers,
            Obligation::IfcAppearance, Obligation::PersistentFaces, Obligation::FinalGeometry,
            Obligation::ProtectedRemoval, Obligation::Publication];
        if self.type_product { unchecked.push(Obligation::ProductPlacement); }
        if matches!(outcome, wire::NativeOutcome::Refused(_)) { unchecked.push(Obligation::NumericalEvaluation); }
        let unchecked = obligations.unwrap_or(unchecked);
        let report = wire::NativeReport { schema_version: 1., kind: "native_transaction_diagnostic".into(),
            authority: "diagnostic_only".into(), identity: self.binding.identity.clone(),
            implementation_commit: self.implementation_commit, product: self.binding.requested[0].clone(),
            outcome, unchecked, final_product_available: false };
        let invalid = || protocol(ReceiptFailure::DiagnosticSerialization);
        wire::validate_native(&report, &self.binding).map_err(|_| invalid())?;
        let bytes = serde_json::to_vec(&report).map_err(|_| invalid())?;
        let text = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
        wire::decode_native_report(text, &self.binding).map_err(|_| invalid())?;
        // A successful diagnostic remains subject to the original resources.
        if matches!(report.outcome, wire::NativeOutcome::Intermediate(_)) { check_resources(&self.resources)?; }
        Ok(ReportBytes { bytes, _storage: self.storage })
    }
}

fn failure(error: &RetainedExecutionError) -> wire::NativeFailure {
    use wire::{Code, DetailReason as Reason, Requirement as Req, Stage};
    let code = error.code();
    let (reason, stage, requirement) = match code {
        Code::InvalidOptions => (Reason::Invalid, Stage::Configuration, Req::Configuration),
        Code::SourceInvalid => (Reason::Invalid, Stage::Source, Req::SourceAuthentication),
        Code::SourceMissing => (Reason::Unavailable, Stage::Source, Req::SourceAuthentication),
        Code::SourceMismatch => (Reason::Mismatch, Stage::Source, Req::SourceAuthentication),
        Code::SourceStale => (Reason::Stale, Stage::Source, Req::SourceAuthentication),
        Code::OwnerMismatch => (Reason::Mismatch, Stage::Ownership, Req::Ownership),
        Code::OwnerBusy => (Reason::Busy, Stage::Ownership, Req::Ownership),
        Code::ReceiptInvalid => (Reason::Invalid, Stage::Ownership, Req::Ownership),
        Code::OperationUnsupported => (Reason::Unsupported, Stage::Representation, Req::Representation),
        Code::WorkerRetired => (Reason::Stale, Stage::Transport, Req::NumericalEvaluation),
        Code::ResourceExhausted => (Reason::Exhausted, Stage::Transport, Req::NumericalEvaluation),
        Code::DeadlineExceeded => (Reason::Deadline, Stage::Transport, Req::NumericalEvaluation),
        Code::Cancelled => (Reason::Cancelled, Stage::Transport, Req::NumericalEvaluation),
        Code::PublicationFailed => (Reason::BackendFailure, Stage::Publication, Req::Publication),
        _ => (Reason::BackendFailure, Stage::Transport, Req::NumericalEvaluation),
    };
    let origin = match error {
        RetainedExecutionError::Stopped(ProgramStop::ResourceRefused(stop)) => resource_origin(*stop),
        _ => match code {
            Code::Cancelled => wire::NativeOrigin::Cancelled(Box::new(wire::NativeNoPayload {})),
            Code::DeadlineExceeded => wire::NativeOrigin::Deadline(Box::new(wire::NativeNoPayload {})),
            Code::ResourceExhausted => wire::NativeOrigin::RuntimeLimit(Box::new(wire::NativeNoPayload {})),
            _ => wire::NativeOrigin::Transaction(Box::new(wire::NativeNoPayload {})),
        },
    };
    wire::NativeFailure { family: wire::cause_family(&code), code, stage, requirement, reason, origin,
        exact_retry: "explicit_new_exact_request".into() }
}
fn resource_origin(stop: resource::ResourceFailure) -> wire::NativeOrigin {
    use resource::{Dimension as D, RefusalReason as R};
    let dimension = match stop.dimension {
        D::Work => wire::ResourceDimension::Work, D::CopyBytes => wire::ResourceDimension::CopyBytes,
        D::OutputBytes => wire::ResourceDimension::OutputBytes, D::Occurrences => wire::ResourceDimension::Occurrences,
        D::LiveBytes => wire::ResourceDimension::LiveBytes, D::Representation => wire::ResourceDimension::Representation,
        D::Coverage => wire::ResourceDimension::Coverage,
    };
    let reason = match stop.reason {
        R::Limit => wire::ResourceReason::Limit, R::Overflow => wire::ResourceReason::Overflow,
        R::Allocation => wire::ResourceReason::Allocation, R::UnsupportedCoverage => wire::ResourceReason::UnsupportedCoverage,
    };
    wire::NativeOrigin::ResourceStop(Box::new(wire::OriginalResourceStop {
        dimension, requested: stop.requested.to_string(), remaining: stop.remaining.to_string(), reason,
    }))
}
