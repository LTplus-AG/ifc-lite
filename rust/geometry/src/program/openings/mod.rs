// SPDX-License-Identifier: MPL-2.0
//! Owned opening source capture. A host's openings are classified, and an
//! opening's items probed, by polled controls whose source admissions,
//! numerical packets and canonical item children are separate requests. The
//! void gateway consumes the classified output; the synchronous drain below
//! is the only executor today.
mod classify;
mod decision;
pub(crate) mod ready;
pub(crate) mod requests;

use crate::program::opening::{OpeningBounds, OpeningChild, OpeningProgram};
use crate::router::voids::OpeningType;
use crate::{Error, GeometryRouter, Mesh, Result};
use classify::Classifier;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use requests::{OpeningReady, OpeningReply, OpeningSource};

pub(crate) enum OpeningOutput {
    Classified(Vec<OpeningType>),
    Meshes(Vec<Mesh>),
    Bounds(OpeningBounds),
}

pub(crate) enum OpeningPoll {
    Source(OpeningSource),
    Ready(OpeningReady),
    /// The reached item's canonical child program.
    Geometry,
    Complete(Result<OpeningOutput>),
}

/// The root of one opening control. It borrows its caller's host or element
/// and opening ids; only decoded occurrences and probe state are owned.
pub(crate) struct OpeningControl<'a>(Root<'a>);
enum Root<'a> {
    Classifier(Classifier<'a>),
    Probe(&'a DecodedEntity, OpeningProgram),
}

impl<'a> OpeningControl<'a> {
    /// Classify `ids` for `host`; `recording` publishes statistics and the
    /// host diagnostic, quiet mode publishes nothing.
    pub(crate) fn classifier(host: &'a DecodedEntity, ids: &'a [u32], recording: bool) -> Self {
        Self(Root::Classifier(Classifier::new(host, ids, recording)))
    }

    pub(crate) fn probe(element: &'a DecodedEntity, meshes: bool) -> Self {
        Self(Root::Probe(element, OpeningProgram::new(meshes)))
    }

    pub(crate) fn poll(&mut self) -> OpeningPoll {
        match &mut self.0 {
            Root::Classifier(control) => control.poll(),
            Root::Probe(_, control) => control.poll(),
        }
    }

    pub(crate) fn source(
        &self,
        source: OpeningSource,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) -> OpeningReply {
        match &self.0 {
            Root::Classifier(control) => control.source(source, router, decoder),
            Root::Probe(element, control) => control.source(element, source, router, decoder),
        }
    }

    pub(crate) fn child(&self, router: &GeometryRouter) -> Result<OpeningChild<'_>> {
        match &self.0 {
            Root::Classifier(control) => control.child(router),
            Root::Probe(_, control) => control.child(router),
        }
    }

    pub(crate) fn resume(&mut self, reply: OpeningReply, router: &GeometryRouter) {
        match &mut self.0 {
            Root::Classifier(control) => control.resume(reply, router),
            Root::Probe(_, control) => control.resume(reply),
        }
    }

    /// Run every request synchronously against one router and decoder. A
    /// reached stop ends the control before its next request.
    pub(crate) fn drain(mut self, router: &GeometryRouter, decoder: &mut EntityDecoder) -> Result<OpeningOutput> {
        loop {
            crate::resource::check_current()?;
            let reply = match self.poll() {
                OpeningPoll::Source(source) => self.source(source, router, decoder),
                OpeningPoll::Ready(ready) => ready.execute(),
                OpeningPoll::Geometry => {
                    OpeningReply::Parts(self.child(router).and_then(|child| child.run(router, decoder)))
                }
                OpeningPoll::Complete(output) => return output,
            };
            self.resume(reply, router);
        }
    }
}

/// Classify a host's requested openings for the void gateway.
pub(crate) fn classify(
    host: &DecodedEntity,
    ids: &[u32],
    recording: bool,
    router: &GeometryRouter,
    decoder: &mut EntityDecoder,
) -> Result<Vec<OpeningType>> {
    match OpeningControl::classifier(host, ids, recording).drain(router, decoder)? {
        OpeningOutput::Classified(openings) => Ok(openings),
        _ => Err(protocol("classifier output")),
    }
}

pub(crate) fn item_meshes(
    element: &DecodedEntity,
    router: &GeometryRouter,
    decoder: &mut EntityDecoder,
) -> Result<Vec<Mesh>> {
    match OpeningControl::probe(element, true).drain(router, decoder)? {
        OpeningOutput::Meshes(meshes) => Ok(meshes),
        _ => Err(protocol("opening meshes output")),
    }
}

pub(crate) fn item_bounds(
    element: &DecodedEntity,
    router: &GeometryRouter,
    decoder: &mut EntityDecoder,
) -> Result<OpeningBounds> {
    match OpeningControl::probe(element, false).drain(router, decoder)? {
        OpeningOutput::Bounds(bounds) => Ok(bounds),
        _ => Err(protocol("opening bounds output")),
    }
}

pub(crate) fn protocol(what: &str) -> Error {
    Error::geometry(format!("opening program protocol: {what}"))
}

/// An ordinary source fault is a miss; a typed stop is never one.
fn source_option<T>(result: Result<T>) -> Result<Option<T>> {
    match crate::resource::observe(result) {
        Ok(value) => Ok(Some(value)),
        Err(error @ Error::ProgramStopped(_)) => Err(error),
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests;
