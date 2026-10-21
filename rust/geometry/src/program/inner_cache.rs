// SPDX-License-Identifier: MPL-2.0
//! Representation-item cache ownership around the same selected item control.
//!
//! Admission (content-dedup lookup and failure-log mark), the item's own work,
//! router-local hash dedup, the source-free rep-identity hash and publication
//! are separate steps. Publication capability stays here until validated
//! acceptance; the hash step owns derived geometry only.
use super::inner::{ProgramError, ProgramStage};
use super::item::{ItemControl, ItemStep};
use crate::router::item_cache_program::{direct_rep_identity, CacheAdmission, CacheContext};
use crate::{GeometryRouter, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

enum State {
    Begin,
    Child(CacheContext, ItemControl),
    Hash(CacheContext, Mesh),
    Publishing(CacheContext),
    Complete(Result<Mesh>),
    /// Moved out by an executing or accepting step.
    Taken,
}

pub(super) enum CacheReply {
    Begin(Result<CacheAdmission>),
    Item(ItemStep),
    Hash(Mesh, Option<u128>),
}

pub(super) struct CacheControl<'a> {
    item: &'a DecodedEntity,
    offset: (f64, f64, f64),
    state: State,
}

impl<'a> CacheControl<'a> {
    pub(super) fn new(item: &'a DecodedEntity, offset: (f64, f64, f64)) -> Self {
        Self { item, offset, state: State::Begin }
    }

    pub(super) fn stage(&self) -> std::result::Result<Option<ProgramStage>, ProgramError> {
        match &self.state {
            State::Begin => Ok(Some(ProgramStage::Source)),
            State::Child(_, item) => item.stage(),
            State::Hash(..) => Ok(Some(ProgramStage::Numerical)),
            State::Complete(_) => Ok(None),
            State::Publishing(_) | State::Taken => Err(ProgramError::Outstanding),
        }
    }

    pub(super) fn execute(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> std::result::Result<CacheReply, ProgramError> {
        match &mut self.state {
            State::Begin => {
                return Ok(CacheReply::Begin(router.admit_item_cache(self.item, decoder, self.offset)));
            }
            State::Child(_, control) => {
                return control.execute(self.item, router, decoder).map(CacheReply::Item);
            }
            _ => {}
        }
        match std::mem::replace(&mut self.state, State::Taken) {
            State::Hash(context, mesh) => {
                self.state = State::Publishing(context);
                let rep = direct_rep_identity(&mesh);
                Ok(CacheReply::Hash(mesh, rep))
            }
            other => {
                self.state = other;
                Err(ProgramError::StaleRequest)
            }
        }
    }

    pub(super) fn accept(&mut self, reply: CacheReply, router: &GeometryRouter) {
        self.state = match (std::mem::replace(&mut self.state, State::Taken), reply) {
            (State::Begin, CacheReply::Begin(Ok(CacheAdmission::Hit(mesh)))) => State::Complete(Ok(mesh)),
            (State::Begin, CacheReply::Begin(Err(error))) => State::Complete(Err(error)),
            (State::Begin, CacheReply::Begin(Ok(CacheAdmission::Miss(context)))) => {
                State::Child(context, ItemControl::new(self.offset))
            }
            (State::Child(context, mut item), CacheReply::Item(step)) => {
                item.accept(step, router);
                match item.take_result() {
                    None => State::Child(context, item),
                    Some(Ok(mesh)) => match router.accept_local_item_cache(mesh) {
                        Ok(mesh) => State::Hash(context, mesh),
                        Err(error) => State::Complete(Err(error)),
                    },
                    Some(Err(error)) => State::Complete(Err(error)),
                }
            }
            (State::Publishing(context), CacheReply::Hash(mesh, rep)) => {
                State::Complete(Ok(router.publish_item_cache(self.item, context, mesh, rep)))
            }
            // Payload validation precedes acceptance; a mismatch cannot reach here.
            (state, _) => state,
        };
    }

    pub(super) fn take_result(&mut self) -> Option<Result<Mesh>> {
        match std::mem::replace(&mut self.state, State::Taken) {
            State::Complete(result) => Some(result),
            other => {
                self.state = other;
                None
            }
        }
    }
}

#[cfg(test)]
#[path = "inner_cache_tests.rs"]
mod tests;
