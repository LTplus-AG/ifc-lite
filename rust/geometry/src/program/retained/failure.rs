// SPDX-License-Identifier: MPL-2.0
//! Private provenance, not a wire taxonomy. No source/decoder/TLS lease is held.
// TODO(remove-by: Cut C, owner: sessionf778e361, #7955): private report consumer.
#![cfg_attr(not(test), allow(dead_code))]
use crate::document::RetainedRefusal;
use crate::representation::ShapeError;
use crate::resource::{self, Cost, ProgramStop, Reservation};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::program) enum FailureSite {
    ProductRoot, ProductShape, RepresentationItems, Constructor,
    ProductCompletion, TypeMapCompletion, TypeBinding,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::program) enum StructuralReason {
    NotProduct, UnsupportedProduct, RepresentationReference,
    NonemptyReferenceList, NonReferenceMember, RepresentationCategory, ItemCategory,
}
#[derive(Debug)]
pub(in crate::program) enum OriginCause {
    Recipe(RetainedRefusal),
    Shape(ShapeError),
    Core(ifc_lite_core::Error),
    Structure(StructuralReason),
    Processor(Option<crate::router::ProcessorOrigin>),
    /// The common helper has not been converted. Its text is never classified.
    Opaque(crate::Error),
}
#[derive(Debug)]
pub(in crate::program) struct OriginFailure {
    pub(in crate::program) site: FailureSite,
    pub(in crate::program) entity: Option<u32>,
    pub(in crate::program) cause: OriginCause,
    _storage: Reservation,
}

/// At most one owned cause; the published Arc is never mutated or removed.
/// Charge and allocate before locking; release rejected storage after unlocking.
pub(super) struct FailureSlot {
    origin: Mutex<Option<Arc<OriginFailure>>>,
    _storage: Option<Reservation>,
}
impl FailureSlot {
    pub(super) fn new() -> (Self, Option<ProgramStop>) {
        let storage = resource::charge(Cost {
            live_bytes: std::mem::size_of::<Self>() as u64, ..Default::default()
        });
        let stop = storage.as_ref().err().copied();
        (Self { origin: Mutex::new(None), _storage: storage.ok() }, stop)
    }
    pub(super) fn get(&self) -> Option<Arc<OriginFailure>> {
        self.origin.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub(super) fn record(&self, site: FailureSite, entity: Option<u32>, cause: OriginCause)
        -> Result<(), ProgramStop> {
        if self.get().is_some() { return Ok(()); }
        // Bound retained payload capacity even in the compatibility domain.
        // Unknown opaque IO backing cannot be audited and is refused as such.
        let bytes = cause_bytes(&cause).ok_or_else(|| resource::refused(
            resource::Dimension::Coverage, 0, 0, resource::RefusalReason::UnsupportedCoverage))?;
        const MAX_CAUSE_BYTES: u64 = 16 * 1024;
        if bytes > MAX_CAUSE_BYTES {
            return Err(resource::refused(resource::Dimension::LiveBytes, bytes,
                MAX_CAUSE_BYTES, resource::RefusalReason::Limit));
        }
        let storage = resource::charge(Cost {
            live_bytes: bytes + (std::mem::size_of::<OriginFailure>() + 2 * std::mem::size_of::<usize>()) as u64,
            ..Default::default()
        })?;
        let origin = Arc::new(OriginFailure { site, entity, cause, _storage: storage });
        let discarded = {
            let mut slot = self.origin.lock().unwrap_or_else(|e| e.into_inner());
            if slot.is_none() { *slot = Some(origin); None } else { Some(origin) }
        };
        drop(discarded);
        Ok(())
    }
}
fn core_bytes(error: &ifc_lite_core::Error) -> Option<u64> {
    use ifc_lite_core::Error;
    Some(match error {
        Error::ParseError { message, .. } => message.capacity() as u64,
        Error::InvalidIfcType(text) => text.capacity() as u64,
        Error::UnexpectedToken { expected, got, .. } => expected.capacity() as u64 + got.capacity() as u64,
        Error::Io(_) => return None,
        Error::InvalidEntityRef(_) | Error::Utf8(_) | Error::UnrepresentableReal(_)
        | Error::MalformedRecord(_) | Error::UnusableUnitFactor { .. } => 0,
    })
}
fn cause_bytes(cause: &OriginCause) -> Option<u64> {
    use crate::Error;
    match cause {
        OriginCause::Recipe(RetainedRefusal::UnsupportedSource(text)) => Some(text.capacity() as u64),
        // UnknownIfcType owns an exact-sized normalized keyword (core schema
        // constructor); only its immutable spelling is exposed by that type.
        OriginCause::Shape(ShapeError::NotAProductDefinitionShape(ifc_lite_core::IfcType::Unknown(name))) => Some(name.as_str().len() as u64),
        OriginCause::Core(error) | OriginCause::Shape(ShapeError::Decode(error))
        | OriginCause::Opaque(Error::CoreError(error)) => core_bytes(error),
        OriginCause::Opaque(Error::TriangulationError(text) | Error::InvalidProfile(text)
            | Error::InvalidExtrusion(text) | Error::EmptyMesh(text) | Error::GeometryError(text)) => Some(text.capacity() as u64),
        _ => Some(0),
    }
}

#[derive(Clone)]
pub(in crate::program) struct FailureHandle {
    #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
    walk: Arc<super::walk::RetainedWalk>,
}
impl FailureHandle {
    #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
    pub(super) fn new(walk: Arc<super::walk::RetainedWalk>) -> Self { Self { walk } }
    pub(in crate::program) fn origin(&self) -> Option<Arc<OriginFailure>> {
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        { self.walk.1.get() }
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        { None }
    }
    pub(in crate::program) fn record(&self, site: FailureSite, entity: Option<u32>, cause: OriginCause) {
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        if let Err(stop) = self.walk.1.record(site, entity, cause) { self.walk.remember(stop); }
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        let _ = (site, entity, cause);
    }
    fn check(&self) -> Result<(), ProgramStop> {
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        { self.walk.check() }
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        { Ok(()) }
    }
    fn remember_stop(&self, stop: ProgramStop) -> ProgramStop {
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        { self.walk.remember(stop) }
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        { stop }
    }
    pub(in crate::program) fn reported(&self) -> Option<RetainedFailure> {
        if let Err(stop) = self.check() { return Some(RetainedFailure::Stopped(stop)); }
        self.origin().map(|_| RetainedFailure::Origin(self.clone()))
    }
    pub(in crate::program) fn common(&self, site: FailureSite, error: crate::Error) -> RetainedFailure {
        match error {
            crate::Error::ProgramStopped(stop) => RetainedFailure::Stopped(self.remember_stop(stop)),
            error => {
                let cause = match error {
                    crate::Error::CoreError(core) => OriginCause::Core(core),
                    other => OriginCause::Opaque(other),
                };
                self.record(site, None, cause);
                // Recording either installs an origin, preserves an earlier one,
                // or records the actual storage stop. No string classification.
                self.reported().expect("retained failure recorded")
            }
        }
    }
}
impl std::fmt::Debug for FailureHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("FailureHandle").field(&self.origin()).finish()
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::program) enum CompletionReason {
    UnexecutedRequest, UnacceptedReply, Incomplete, TypeMapRootMissing,
    NonfiniteTypeColor, WrongOutputKind, ProductPlacementMissing,
}
#[derive(Debug)]
pub(in crate::program) enum RetainedFailure {
    Stopped(ProgramStop),
    Protocol(crate::program::inner::retained_program::RetainedProgramError),
    Origin(FailureHandle),
    Completion(CompletionReason),
}
impl From<crate::program::inner::retained_program::RetainedProgramError> for RetainedFailure {
    fn from(error: crate::program::inner::retained_program::RetainedProgramError) -> Self {
        match error {
            crate::program::inner::retained_program::RetainedProgramError::Stopped(stop) => Self::Stopped(stop),
            other => Self::Protocol(other),
        }
    }
}
impl std::fmt::Display for RetainedFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stopped(stop) => write!(f, "{stop}"),
            Self::Origin(handle) => match handle.origin().as_deref().map(|origin| &origin.cause) {
                Some(OriginCause::Opaque(error)) => write!(f, "{error}"),
                Some(OriginCause::Recipe(error)) => write!(f, "{error}"),
                Some(OriginCause::Core(error)) => write!(f, "Core parser error: {error}"),
                other => write!(f, "retained origin: {other:?}"),
            },
            other => write!(f, "{other:?}"),
        }
    }
}
