// SPDX-License-Identifier: MPL-2.0
//! Opaque controller bridge consumed by processing's retained executor.
//! Logical annotations grant neither numerical receipts nor final geometry.
use super::inner::retained_program as controller;
use super::retained as logical;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use crate::{GeometryRouter, ResolvedTextureMap};
use crate::resource::{OwnedResourceContext, ProgramStop, Reservation};

mod error;
mod values;
pub use error::{TransactionError, TransactionFailureKind};
pub use values::{Definition, Operation, OperationKind, Plan, Requirement, Slot, Value, ValueRef};

/// The original stop/account domain; contains no execution or TLS guard.
#[derive(Clone)]
pub struct Resources(OwnedResourceContext);
impl Resources {
    /// Processing calls this only inside authenticated source-owner work.
    pub fn capture_current() -> Self { Self(OwnedResourceContext::capture_current()) }
    pub fn check(&self) -> Result<(), ProgramStop> { self.0.check() }
    pub fn with_scope<T>(&self, work: impl FnOnce() -> T) -> T { self.0.with_scope(work) }
    pub fn reserve_headers<T>(&self, values: &mut Vec<T>, additional: usize)
        -> Result<Reservation, ProgramStop> { self.0.reserve_headers(values, additional) }
}

pub struct Traversal(controller::RetainedTraversal);
impl Traversal {
    pub fn new(source_epoch: u64, source_revision: u64) -> Self {
        Self(controller::RetainedTraversal::new(logical::RetainedContract { source_epoch, source_revision }))
    }
    pub fn product_parts<'a>(&self, root: &'a DecodedEntity) -> Program<'a> {
        Program(self.0.product_parts(root))
    }
    pub fn product_submeshes<'a>(&self, root: &'a DecodedEntity,
        textures: &'a rustc_hash::FxHashMap<u32, ResolvedTextureMap>) -> Program<'a> {
        Program(self.0.product_submeshes(root, true, Some(textures)))
    }
    pub fn type_map<'a>(&self, root: DecodedEntity,
        textures: &'a rustc_hash::FxHashMap<u32, ResolvedTextureMap>) -> Program<'a> {
        Program(self.0.type_map(root, Some(textures)))
    }
}

pub struct Program<'a>(controller::RetainedProgram<'a>);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ticket(controller::RetainedTicket);
pub struct Reply(controller::RetainedReply);
/// A reply the program refused. The program keeps its pending state, so a
/// retryable refusal (`WrongOwner`, `StaleRequest`) is resubmitted with
/// [`RejectedReply::into_reply`].
pub struct RejectedReply { pub error: TransactionError, reply: Reply }
impl RejectedReply {
    /// The refused reply, intact, for resubmission to [`Program::accept`].
    pub fn into_reply(self) -> Reply { self.reply }
}
impl Program<'_> {
    pub fn request(&mut self) -> Result<Option<Ticket>, TransactionError> {
        self.0.request().map(|ticket| ticket.map(Ticket)).map_err(Into::into)
    }
    pub fn admit(&mut self, ticket: Ticket, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> Result<(Reply, Vec<Operation>, Reservation), TransactionError> {
        let (reply, operations) = self.0.admit(ticket.0, router, decoder)?;
        // Do not charge the wrapper Vec permanently to an ambient account.
        // A stop here drops the admitted reply. Stops are terminal for the
        // product, so latch it: later requests and finish report the stop.
        let resources = Resources::capture_current();
        let mut wrapped = Vec::new();
        let latch = |program: &Self, stop: ProgramStop| {
            program.0.remember_stop(stop);
            TransactionError::stopped(stop)
        };
        let storage = resources.reserve_headers(&mut wrapped, operations.len()).map_err(|stop| latch(self, stop))?;
        wrapped.extend(operations.into_iter().map(Operation));
        resources.check().map_err(|stop| latch(self, stop))?;
        Ok((Reply(reply), wrapped, storage))
    }
    pub fn validate_ticket(&self, ticket: Ticket) -> Result<(), TransactionError> {
        self.0.validate_ticket(ticket.0).map_err(Into::into)
    }
    pub fn validate_reply(&self, reply: &Reply, router: &GeometryRouter) -> Result<(), TransactionError> {
        self.0.validate_reply(&reply.0, router).map_err(Into::into)
    }
    pub fn accept(&mut self, reply: Reply, router: &GeometryRouter) -> Result<(), Box<RejectedReply>> {
        self.0.accept(reply.0, router).map_err(|rejected| Box::new(RejectedReply {
            error: rejected.error.into(), reply: Reply(rejected.reply),
        }))
    }
    pub fn cancel(&mut self) { self.0.cancel(); }
    pub fn finish(self) -> Result<Plan, TransactionError> {
        self.0.finish().map(Plan::new).map_err(Into::into)
    }
    pub fn finish_type_map(self, product: u32, class: u8, color: [f32; 4]) -> Result<Plan, TransactionError> {
        self.0.finish_type_map(product, class, color).map(Plan::new).map_err(Into::into)
    }
}

/// Authenticate the original immutable source allocation as well as all request
/// document/revision/definition/incarnation fields. Equal bytes are insufficient.
pub fn same_admission(request: &crate::document::RetainedRequest,
    completed: &crate::document::RetainedRequest) -> bool {
    request.same_admission(completed)
}
