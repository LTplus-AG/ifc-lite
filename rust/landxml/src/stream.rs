/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

mod derived;
mod event;
mod feed;
mod fragments;
mod lifecycle;
pub(crate) mod metadata;
mod output;
mod record_wire;
pub use lifecycle::LandXmlMetadataStreamAssembler;

use crate::{
    alignment::parser::AlignmentHandler,
    parser::TinHandler,
    pipe_parser::PipeHandler,
    plan::parser::PlanHandler,
    xml::{error, Decoder, Driver, FamilyHandler, Meter, TokenKind, TokenScanner},
    LandXmlDiagnosticCode as Code,
    LandXmlError, LandXmlLimits,
};
pub use event::{
    LandXmlMetadataRecord, LandXmlMetadataRecordFragment, LandXmlMetadataStreamEnd,
    LandXmlMetadataStreamEvent, LandXmlMetadataStreamHeader, LandXmlStreamEvent,
    LandXmlStreamHeader, LandXmlStreamMetadata, LandXmlStreamSummary, LandXmlSurfaceComponent,
    LandXmlSurfaceFragment,
};
use quick_xml::{events::Event, Reader};
use std::{collections::VecDeque, io::BufReader};
use feed::TokenFeed;

pub const MAX_LANDXML_STREAM_INPUT_CHUNK_BYTES: usize = 1024 * 1024;
pub const MAX_LANDXML_STREAM_DRAIN_BYTES: usize = 1024 * 1024;
/// The host must return transport credit by draining before more XML is read.
pub const MAX_LANDXML_STREAM_QUEUED_BYTES: usize = 512 * 1024;
pub const MAX_LANDXML_STREAM_QUEUED_EVENTS: usize = 4;
/// Maximum serialized event retained while reserving queue headroom.
pub const MAX_LANDXML_STREAM_EVENT_BYTES: usize = 192 * 1024;
/// A single semantic metadata value may legally exceed one transport event,
/// but no serializer/reassembler state may exceed the host's one-credit cap.
pub const MAX_LANDXML_STREAM_METADATA_RECORD_BYTES: usize = MAX_LANDXML_STREAM_QUEUED_BYTES;

struct QueuedEvent {
    event: LandXmlStreamEvent,
    serialized_bytes: usize,
}

pub struct LandXmlTinStreamSession {
    tin: Option<TinHandler<'static>>,
    /// The one XML driver; the TIN family is the first handler it feeds.
    driver: Option<Driver<'static>>,
    plan: Option<PlanHandler>,
    alignment: Option<AlignmentHandler>,
    pipe: Option<PipeHandler<'static>>,
    reader: Reader<BufReader<TokenFeed>>,
    feed: TokenFeed,
    decoder: Decoder,
    scanner: TokenScanner,
    queue: VecDeque<QueuedEvent>,
    queued_bytes: usize,
    pending_surface: Option<fragments::SurfaceCursor>,
    metadata_cursor: Option<metadata::MetadataCursor>,
    /// Normalized bytes not yet scanned, from `pending_start`.
    pending_input: Vec<u8>,
    pending_start: usize,
    header_emitted: bool,
    /// The emitted header committed to the caller's assumed unit (#7753).
    header_assumed: bool,
    surfaces_drained: usize,
    renderable_surfaces: usize,
    preserved_surfaces: usize,
    closed: bool,
}

impl LandXmlTinStreamSession {
    pub fn new(limits: LandXmlLimits) -> Result<Self, LandXmlError> {
        // #5175: validate a caller-supplied assumed-unit override up front,
        // the same as the non-streaming entry point, so a bad token refuses
        // at session construction rather than partway through a stream.
        let assumed_units = crate::semantics::resolve_assumed_units(&limits)?;
        let feed = TokenFeed::new();
        let meter = Meter::new(limits.max_work, None);
        let mut reader = Reader::from_reader(BufReader::new(feed.clone()));
        reader.config_mut().trim_text(false);
        Ok(Self {
            plan: Some(PlanHandler::new(
                &crate::LandXmlPlanLimits { xml: limits.clone(), ..Default::default() },
                assumed_units.clone(),
            )),
            alignment: Some(AlignmentHandler::new(
                &crate::alignment::LandXmlAlignmentLimits { xml: limits.clone(), ..Default::default() },
                false,
                assumed_units.clone(),
            )),
            tin: Some(TinHandler::new(&limits, meter.clone(), None, assumed_units)),
            pipe: Some(PipeHandler::new(&limits, meter.clone(), false)),
            driver: Some(Driver::new(&limits, meter)),
            reader,
            feed,
            decoder: Decoder::new(&limits)?,
            scanner: TokenScanner::new(&limits, true)?,
            queue: VecDeque::new(),
            queued_bytes: 0,
            pending_surface: None,
            metadata_cursor: None,
            pending_input: Vec::new(),
            pending_start: 0,
            header_emitted: false,
            header_assumed: false,
            surfaces_drained: 0,
            renderable_surfaces: 0,
            preserved_surfaces: 0,
            closed: false,
        })
    }

    pub fn advance(&mut self, chunk: &[u8]) -> Result<(), LandXmlError> {
        if self.closed {
            return Err(error(Code::InvalidSemantic, "LandXML stream session is closed"));
        }
        if chunk.len() > MAX_LANDXML_STREAM_INPUT_CHUNK_BYTES {
            return Err(error(Code::InputTooLarge, "input chunk exceeds byte limit"));
        }
        if self.output_pending() {
            return Err(error(
                Code::LimitExceeded,
                "stream output must be drained before advancing input",
            ));
        }
        let parsed = self.decoder.push(chunk).and_then(|bytes| {
            self.feed_input(bytes);
            self.consume_pending_input()
        });
        self.close_on_error(parsed)
    }

    pub fn drain(&mut self, max_bytes: usize) -> Result<Vec<LandXmlStreamEvent>, LandXmlError> {
        if max_bytes == 0 || max_bytes > MAX_LANDXML_STREAM_DRAIN_BYTES {
            return Err(error(Code::LimitExceeded, "invalid stream drain budget"));
        }
        let mut bytes = 0usize;
        let mut events = Vec::new();
        while let Some(queued) = self.queue.front() {
            let size = queued.serialized_bytes;
            if size > max_bytes {
                return Err(error(
                    Code::LimitExceeded,
                    "stream event exceeds drain budget",
                ));
            }
            if !events.is_empty() && bytes + size > max_bytes {
                break;
            }
            bytes += size;
            let queued = self.queue.pop_front().expect("front checked");
            self.queued_bytes -= queued.serialized_bytes;
            events.push(queued.event);
        }
        let resumed = self.resume_after_drain();
        self.close_on_error(resumed).map(|()| events)
    }

    /// Finalize parsing and begin credited metadata delivery.
    ///
    /// Call [`Self::drain`] until [`Self::output_pending`] is false. Metadata
    /// is emitted as bounded header, record, and end events without cloning
    /// the finalized family documents.
    pub fn finish_cursor(&mut self) -> Result<(), LandXmlError> {
        if self.closed {
            return Err(error(Code::InvalidSemantic, "LandXML stream session is closed"));
        }
        let decoded = self.decoder.finish().map(|tail| self.feed_input(tail));
        let decoded = decoded.and_then(|()| self.consume_pending_input());
        self.close_on_error(decoded)?;
        // Undrained output is recoverable (drain, then retry); other errors close.
        if self.output_pending() || self.pending_start < self.pending_input.len() {
            return Err(error(Code::LimitExceeded, "stream output must be drained before finalization"));
        }
        let finished = self.finish_document();
        self.close_on_error(finished)
    }

    fn finish_document(&mut self) -> Result<(), LandXmlError> {
        if let Some(kind) = self.scanner.finish()? {
            self.emit_token(kind)?;
        }
        self.driver.take().expect("open driver").finish()?;
        let header = self
            .header()
            .ok_or_else(|| error(Code::InvalidXml, "LandXML document is empty"))?;
        if !self.header_emitted {
            self.push_event(LandXmlStreamEvent::Header(header.clone()))?;
            self.header_emitted = true;
        }
        self.closed = true;
        let terrain = self.tin.take().expect("open TIN handler").finish()?;
        let plan = self.plan.take().expect("open plan handler").document();
        let alignment = self.alignment.take().expect("open alignment handler").finish()?;
        let (pipe, preflight_refusal_batches, has_pipe_networks) =
            self.pipe.take().expect("open pipe handler").finish_stream_with_preflight()?;
        let pipe_networks = pipe.networks.len();
        let pipe_structures = pipe
            .networks
            .iter()
            .map(|network| network.structures.len())
            .sum();
        let pipes = pipe
            .networks
            .iter()
            .map(|network| network.pipes.len())
            .sum();
        let pipe_refusals = pipe.refusals.len();
        let end = LandXmlMetadataStreamEnd {
            surfaces_drained: self.surfaces_drained,
            renderable_surfaces: self.renderable_surfaces,
            preserved_surfaces: self.preserved_surfaces,
            plan_cogo_points: plan.cogo_points().len(),
            plan_parcels: plan.parcels.len(),
            horizontal_alignments: alignment.alignments.len(),
            has_pipe_networks,
            pipe_networks,
            pipe_structures,
            pipes,
            pipe_refusals,
        };
        self.metadata_cursor = Some(metadata::MetadataCursor::new(
            header,
            terrain.into_stream_parts(),
            plan,
            alignment,
            pipe.into_stream_parts(preflight_refusal_batches),
            end,
        ));
        self.flush_pending_metadata()
    }

    fn tin(&mut self) -> &mut TinHandler<'static> {
        self.tin.as_mut().expect("open TIN handler")
    }

    fn feed_input(&mut self, bytes: Vec<u8>) {
        if self.pending_start == self.pending_input.len() {
            self.pending_input = bytes;
            self.pending_start = 0;
        } else {
            self.pending_input.extend_from_slice(&bytes);
        }
    }

    fn consume_pending_input(&mut self) -> Result<(), LandXmlError> {
        while !self.output_pending() && self.pending_start < self.pending_input.len() {
            let step = self.scanner.next(&self.pending_input[self.pending_start..])?;
            self.pending_start += step.consumed;
            if let Some(kind) = step.token {
                self.emit_token(kind)?;
            }
        }
        Ok(())
    }

    fn resume_after_drain(&mut self) -> Result<(), LandXmlError> {
        self.flush_pending_surface()?;
        self.flush_pending_metadata()?;
        self.consume_pending_input()
    }

    fn emit_token(&mut self, kind: TokenKind) -> Result<(), LandXmlError> {
        let token = self.scanner.take_token();
        let text_token = kind == TokenKind::Text;
        let comment_token = kind == TokenKind::Comment;
        self.feed.push(&token);
        if text_token {
            self.feed.push(b"<!--ifc-lite-stream-pad-->");
        } else if comment_token {
            // Keep quick-xml from observing EOF for a standalone comment.
            // The processing instruction is deliberately not exposed to the
            // semantic parsers below.
            self.feed.push(b"<?ifc-lite-stream-pad?>");
        }
        let mut buffer = Vec::new();
        let mut consumed_comment = false;
        loop {
            let event = self.reader.read_event_into(&mut buffer).map_err(|value| {
                error(Code::InvalidXml, format!("malformed XML token: {value}"))
            })?;
            match event {
                // #7680 EDGE-LXPARSE-3: one text token can be several events
                // (`1&#46;5` is Text, GeneralRef, Text), so a text token is
                // consumed through its own padding comment. Stopping after
                // its first event left the reader lagging for the rest of the
                // document. A text token holds no `<`, so its only comment is
                // that pad, and no pad is ever left for a later token.
                Event::Comment(_) if text_token => break,
                // A real XML comment is a complete legal token, followed by
                // its padding processing instruction.
                Event::Comment(_) => consumed_comment = true,
                Event::PI(_) if comment_token && consumed_comment => break,
                // EOF after only comments is the legitimate standalone-comment case.
                Event::Eof if consumed_comment => break,
                Event::Eof => {
                    return Err(error(
                        Code::InvalidXml,
                        format!("XML reader ended while consuming token {:?}", String::from_utf8_lossy(&token)),
                    ));
                }
                event => {
                    self.dispatch_event(event)?;
                    if !text_token {
                        break;
                    }
                }
            }
            buffer.clear();
        }
        self.scanner.recycle(token);
        self.emit_header_and_surfaces()
    }

    /// Every family handler sees every event of the one canonical reader,
    /// through the one driver: one decode, one work charge, no event clone.
    fn dispatch_event(&mut self, event: Event<'_>) -> Result<(), LandXmlError> {
        let tin: &mut dyn FamilyHandler = self.tin.as_mut().expect("open TIN handler");
        let plan: &mut dyn FamilyHandler = self.plan.as_mut().expect("open plan handler");
        let alignment: &mut dyn FamilyHandler = self.alignment.as_mut().expect("open alignment handler");
        let pipe: &mut dyn FamilyHandler = self.pipe.as_mut().expect("open pipe handler");
        self.driver.as_mut().expect("open driver").event(event, &mut [tin, plan, alignment, pipe])
    }
}
