/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Explicit completion, compatibility summary, and deterministic cleanup.

use super::{
    metadata, LandXmlMetadataStreamEvent, LandXmlStreamEvent, LandXmlStreamHeader,
    LandXmlStreamSummary, LandXmlTinStreamSession, MAX_LANDXML_STREAM_DRAIN_BYTES,
};
use crate::{xml::error, LandXmlDiagnosticCode as Code, LandXmlError};

/// Reassembles move-owned metadata cursor events for adapters that still need
/// a complete semantic document at their compatibility boundary.
#[derive(Default)]
pub struct LandXmlMetadataStreamAssembler {
    inner: metadata::MetadataReassembler,
}

impl LandXmlMetadataStreamAssembler {
    /// Consume one event emitted through [`LandXmlStreamEvent::Metadata`].
    pub fn push(&mut self, event: LandXmlMetadataStreamEvent) -> Result<(), LandXmlError> {
        self.inner.push(event)
    }

    /// Return the reassembled summary after its single end event.
    pub fn finish(self) -> Result<LandXmlStreamSummary, LandXmlError> {
        self.inner.finish()
    }
}

impl LandXmlTinStreamSession {
    /// Finalize and reassemble metadata for legacy summary consumers.
    // TODO(remove-by: #5050 worker cursor migration, owner: LandXML)
    pub fn finish(&mut self) -> Result<LandXmlStreamSummary, LandXmlError> {
        self.finish_cursor()?;
        let mut reassembler = LandXmlMetadataStreamAssembler::default();
        while self.output_pending() {
            for event in self.drain(MAX_LANDXML_STREAM_DRAIN_BYTES)? {
                match event {
                    // Unit-less preserved-only sources emit their transport
                    // header at finish. The metadata header repeats it, so a
                    // legacy summary adapter intentionally consumes this
                    // transport-only record without reassembling it twice.
                    LandXmlStreamEvent::Header(_) => {}
                    LandXmlStreamEvent::Metadata(event) => reassembler.push(*event)?,
                    LandXmlStreamEvent::Surface(_) => {
                        return Err(error(
                            Code::InvalidSemantic,
                            "summary adapter received non-metadata stream output",
                        ));
                    }
                }
            }
        }
        reassembler.finish()
    }

    /// Release every parser, queued event, and resumable cursor on cancellation
    /// or abandonment. This path is deliberately idempotent for WASM hosts.
    pub fn abort(&mut self) {
        self.token.clear();
        self.queue.clear();
        self.queued_bytes = 0;
        self.pending_surface.take();
        self.metadata_cursor.take();
        self.pending_input.clear();
        self.parser.take();
        self.plan.take();
        self.alignment.take();
        self.pipe.take();
        self.closed = true;
    }

    pub fn header(&self) -> Option<LandXmlStreamHeader> {
        self.parser
            .as_ref()?
            .header()
            .map(|(version, units)| LandXmlStreamHeader { version, units })
    }

    /// Whether the caller must grant output credit with [`Self::drain`].
    pub fn output_pending(&self) -> bool {
        !self.queue.is_empty() || self.pending_surface.is_some() || self.metadata_cursor.is_some()
    }

    /// Exact JSON transport bytes currently retained for a credited consumer.
    pub fn queued_bytes(&self) -> usize {
        self.queued_bytes
    }

    /// Number of complete transport records currently retained for a consumer.
    pub fn queued_events(&self) -> usize {
        self.queue.len()
    }
}
