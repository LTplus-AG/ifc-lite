// SPDX-License-Identifier: MPL-2.0
//! Closed internal work protocol. A ticket identifies reached work, not an IFC
//! construction definition or a promise about an emitter's arithmetic kernel.
//! Every packet is validated before any callback, hash or cache access.
use super::assembly_types::TypePart;
use super::plan::PrimaryStrategy;
use super::session_work::{PartsOutcome, PrimaryOutcome};
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WorkKind {
    Primary { strategy: PrimaryStrategy, layer_class: u8 },
    TypeMap { map_id: u32, class: u8 },
    VoidedParts,
    PlainParts,
}

/// Identity only. Copying a request cannot copy or replay its work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct WorkRequest {
    pub session: u64,
    pub sequence: u64,
    pub kind: WorkKind,
    pub context: Option<ProductionContextId>,
}

/// Generated at the actual contextual dispatch site. Nested processor identity
/// remains distinct; this tag must never be called a built-in family identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WorkEmitter {
    TexturedProduct,
    VoidedProduct,
    RepresentationMap,
    VoidedParts,
    PlainParts,
}
impl WorkKind {
    pub fn emitter(self) -> WorkEmitter {
        match self {
            Self::Primary { strategy: PrimaryStrategy::TexturedSubmeshes, .. } => WorkEmitter::TexturedProduct,
            Self::Primary { strategy: PrimaryStrategy::VoidedSubmeshes, .. } => WorkEmitter::VoidedProduct,
            Self::TypeMap { .. } => WorkEmitter::RepresentationMap,
            Self::VoidedParts => WorkEmitter::VoidedParts,
            Self::PlainParts => WorkEmitter::PlainParts,
        }
    }
}

pub(super) enum WorkPayload {
    Stopped(ifc_lite_geometry::resource::ProgramStop),
    Primary(PrimaryOutcome),
    TypeMap(Option<Vec<TypePart>>),
    VoidedParts(PartsOutcome),
    PlainParts(Vec<Mesh>),
}
impl WorkPayload {
    fn matches(&self, kind: WorkKind) -> bool {
        matches!(
            (self, kind),
            (Self::Stopped(_), _)
                | (Self::Primary(_), WorkKind::Primary { .. })
                | (Self::TypeMap(_), WorkKind::TypeMap { .. })
                | (Self::VoidedParts(_), WorkKind::VoidedParts)
                | (Self::PlainParts(_), WorkKind::PlainParts)
        )
    }
}

pub(super) struct WorkReply {
    pub request: WorkRequest,
    pub context: Option<ProductionContextId>,
    pub owner: super::session_owner::OwnerStamp,
    pub emitter: WorkEmitter,
    pub payload: WorkPayload,
}

/// Rejection returns the unconsumed packet to its owner. It never strands a
/// legitimate outstanding reply merely because acceptance used a wrong owner.
/// Only a resumable executor can hold a reply across a refusal.
#[cfg(test)]
pub(super) struct RejectedReply {
    pub error: WorkError,
    pub reply: WorkReply,
}
#[cfg(test)]
impl std::fmt::Debug for RejectedReply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RejectedReply")
            .field("error", &self.error)
            .field("request", &self.reply.request)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkError {
    /// A failed owner commit or an unwind poisoned this continuation.
    Aborted,
    /// Publication was requested before every planned work item finished.
    Unfinished,
    Outstanding,
    StaleTicket,
    AlreadyExecuted,
    NotExecuted,
    WrongEmitter,
    WrongPayload,
    WrongOwner,
    OwnerBusy,
    WrongContext,
    StaleSource,
}

/// One outstanding ticket at a time, and whether it has been executed.
pub(super) struct Protocol {
    session: u64,
    context: Option<ProductionContextId>,
    sequence: u64,
    pending: Option<(WorkRequest, bool)>,
}
impl Protocol {
    /// The snapshot binds before any work exists, so a ticket can never be
    /// issued under one context and accepted under another.
    pub fn new(context: Option<ProductionContextId>) -> Self {
        // 64-bit: wrapping would need 2^64 products in one process.
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let session = NEXT.fetch_add(1, Ordering::Relaxed);
        Self { session, context, sequence: 0, pending: None }
    }
    pub fn idle(&self) -> Result<(), WorkError> {
        if self.pending.is_some() { Err(WorkError::Outstanding) } else { Ok(()) }
    }
    /// Issue the next ticket. The caller has already checked [`Self::idle`].
    pub fn issue(&mut self, kind: WorkKind) -> WorkRequest {
        self.sequence = self.sequence.wrapping_add(1);
        let request = WorkRequest { session: self.session, sequence: self.sequence, kind, context: self.context };
        self.pending = Some((request, false));
        request
    }
    pub fn before_execute(&self, request: WorkRequest) -> Result<(), WorkError> {
        if request.context != self.context {
            return Err(WorkError::WrongContext);
        }
        match self.pending {
            Some((pending, false)) if pending == request => Ok(()),
            Some((pending, true)) if pending == request => Err(WorkError::AlreadyExecuted),
            _ => Err(WorkError::StaleTicket),
        }
    }
    /// Consume admission: a copied ticket cannot execute again.
    pub fn executed(&mut self, request: WorkRequest) {
        self.pending = Some((request, true));
    }
    pub fn before_accept(&self, reply: &WorkReply) -> Result<(), WorkError> {
        if reply.context != self.context || reply.request.context != self.context {
            return Err(WorkError::WrongContext);
        }
        match self.pending {
            Some((pending, true)) if pending == reply.request => {}
            Some((pending, false)) if pending == reply.request => return Err(WorkError::NotExecuted),
            _ => return Err(WorkError::StaleTicket),
        }
        if reply.emitter != reply.request.kind.emitter() {
            return Err(WorkError::WrongEmitter);
        }
        if !reply.payload.matches(reply.request.kind) {
            return Err(WorkError::WrongPayload);
        }
        Ok(())
    }
    pub fn accepted(&mut self) {
        self.pending = None;
    }
}
