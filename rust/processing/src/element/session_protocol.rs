// SPDX-License-Identifier: MPL-2.0
//! Closed internal work protocol. A ticket identifies reached work, not an IFC
//! construction definition or a promise about an emitter's arithmetic kernel.
use super::assembly_types::TypePart;
use super::plan::PrimaryStrategy;
use super::session_work::{PartsOutcome, PrimaryOutcome};
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WorkKind {
    Primary { strategy: PrimaryStrategy, layer_class: u8 },
    TypeMap { map_id: u32, class: u8 },
    VoidedParts,
    PlainParts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct WorkRequest {
    pub session: usize,
    pub sequence: usize,
    pub kind: WorkKind,
    pub context:Option<ProductionContextId>,
    pub inner:Option<ifc_lite_geometry::program::ProgramRequest>,
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

/// Backing admission travels with the unique engine reply, including rejection.
/// The owned permit keeps its original account alive and refunds only on drop;
/// it contains no thread-bound scope or source/router capability.
pub(super) struct AdmittedProgramReply {
    reply: Box<ifc_lite_geometry::program::ProgramReply>,
    _reservation: ifc_lite_geometry::resource::Reservation,
}
impl AdmittedProgramReply {
    pub fn new(reply: ifc_lite_geometry::program::ProgramReply,
        reservation: ifc_lite_geometry::resource::Reservation) -> Self {
        Self { reply: Box::new(reply), _reservation: reservation }
    }
    pub fn into_reply(self) -> ifc_lite_geometry::program::ProgramReply { *self.reply }
}
impl std::ops::Deref for AdmittedProgramReply {
    type Target = ifc_lite_geometry::program::ProgramReply;
    fn deref(&self) -> &Self::Target { &self.reply }
}
impl std::ops::DerefMut for AdmittedProgramReply {
    fn deref_mut(&mut self) -> &mut Self::Target { &mut self.reply }
}

pub(super) enum WorkPayload {
    GeometryStep(AdmittedProgramReply,Option<ifc_lite_geometry::resource::ProgramStop>),
    Stopped(ifc_lite_geometry::resource::ProgramStop),
    Primary(PrimaryOutcome),
    TypeMap(Option<Vec<TypePart>>),
    VoidedParts(PartsOutcome),
    PlainParts(Vec<Mesh>),
}
impl WorkPayload {
    fn matches(&self, request: WorkRequest) -> bool {
        if request.inner.is_some() { return matches!(self,Self::GeometryStep(_,_)|Self::Stopped(_)); }
        let kind=request.kind;
        matches!((self, kind),
            (Self::Stopped(_), _) |
            (Self::Primary(_), WorkKind::Primary { .. }) |
            (Self::TypeMap(_), WorkKind::TypeMap { .. }) |
            (Self::VoidedParts(_), WorkKind::VoidedParts) |
            (Self::PlainParts(_), WorkKind::PlainParts))
    }
}

pub(super) struct WorkReply {
    pub request: WorkRequest,
    pub context:Option<ProductionContextId>,
    pub owner: super::session_owner::OwnerStamp,
    pub emitter: WorkEmitter,
    pub registry_emitters: Vec<ifc_lite_geometry::ProcessorEmitter>,
    pub payload: WorkPayload,
}

/// Rejection returns the unconsumed packet to its owner. It never strands a
/// legitimate outstanding reply merely because acceptance used a wrong owner.
pub(super) struct RejectedReply {
    pub error: WorkError,
    pub reply: WorkReply,
}
impl std::fmt::Debug for RejectedReply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RejectedReply").field("error", &self.error)
            .field("request", &self.reply.request).finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WorkError { RetainedContract, Geometry(ifc_lite_geometry::program::ProgramError), Outstanding, StaleTicket, AlreadyExecuted, NotExecuted, WrongEmitter, WrongPayload, WrongOwner, OwnerBusy, WrongContext, StaleSource, MismatchedSource }

pub(super) struct Protocol {
    session: usize,
    context:Option<ProductionContextId>,
    sequence: usize,
    pending: Option<(WorkRequest, bool)>,
    registry_emitters: Vec<ifc_lite_geometry::ProcessorEmitter>,
}
impl Protocol {
    pub fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(1);
        let session = NEXT.fetch_update(Ordering::Relaxed, Ordering::Relaxed,
            |id| id.checked_add(1)).expect("product session identity exhausted");
        Self { session, context:None, sequence: 0, pending: None, registry_emitters: Vec::new() }
    }
    pub fn bind_context(&mut self,id:ProductionContextId) {
        assert!(self.pending.is_none()&&self.sequence==0&&self.context.is_none(),"context binds before any work");
        self.context=Some(id);
    }
    pub fn idle(&self) -> Result<(), WorkError> {
        if self.pending.is_some() { Err(WorkError::Outstanding) } else { Ok(()) }
    }
    pub fn issue(&mut self, kind: WorkKind) -> WorkRequest {
        self.idle().expect("one outstanding product work item");
        self.sequence = self.sequence.checked_add(1).expect("product work sequence exhausted");
        let request = WorkRequest { session: self.session, sequence: self.sequence, kind, context:self.context, inner:None };
        self.pending = Some((request, false));
        request
    }
    pub fn issue_inner(&mut self,kind:WorkKind,inner:Option<ifc_lite_geometry::program::ProgramRequest>)->WorkRequest {
        let mut request=self.issue(kind);
        request.inner=inner;
        self.pending=Some((request,false));
        request
    }
    pub fn before_execute(&self, request: WorkRequest) -> Result<(), WorkError> {
        if request.context!=self.context {return Err(WorkError::WrongContext)}
        match self.pending {
            Some((pending, false)) if pending == request => Ok(()),
            Some((pending, true)) if pending == request => Err(WorkError::AlreadyExecuted),
            _ => Err(WorkError::StaleTicket),
        }
    }
    pub fn executed(&mut self, request: WorkRequest, registry_emitters: &[ifc_lite_geometry::ProcessorEmitter]) {
        self.before_execute(request).expect("validated product work");
        self.pending = Some((request, true));
        self.registry_emitters = registry_emitters.to_vec();
    }
    pub fn before_accept(&self, reply: &WorkReply) -> Result<(), WorkError> {
        if reply.context!=self.context||reply.request.context!=self.context {return Err(WorkError::WrongContext)}
        match self.pending {
            Some((pending, true)) if pending == reply.request => {}
            Some((pending, false)) if pending == reply.request => return Err(WorkError::NotExecuted),
            _ => return Err(WorkError::StaleTicket),
        }
        if reply.emitter != reply.request.kind.emitter() { return Err(WorkError::WrongEmitter); }
        if reply.registry_emitters != self.registry_emitters { return Err(WorkError::WrongEmitter); }
        if !reply.payload.matches(reply.request) { return Err(WorkError::WrongPayload); }
        Ok(())
    }
    pub fn accepted(&mut self) { self.pending = None; self.registry_emitters.clear(); }
}
