/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

mod decoder;
mod derived;
mod event;
mod fragments;
pub(crate) mod metadata;
mod output;
mod token;

use crate::{
    parser::Parser, preflight::max_markup_bytes, xml::error, LandXmlDiagnosticCode as Code,
    LandXmlError, LandXmlLimits,
};
use decoder::Decoder;
use derived::{alignment_derived_records, plan_derived_records};
pub use event::{
    LandXmlMetadataRecord, LandXmlMetadataStreamEnd, LandXmlMetadataStreamEvent,
    LandXmlMetadataStreamHeader, LandXmlStreamEvent, LandXmlStreamHeader, LandXmlStreamMetadata,
    LandXmlStreamSummary, LandXmlSurfaceComponent, LandXmlSurfaceFragment,
};
use quick_xml::{events::Event, Reader};
use std::{collections::VecDeque, io::BufReader};
use token::{TokenFeed, TokenKind};

pub const MAX_LANDXML_STREAM_INPUT_CHUNK_BYTES: usize = 1024 * 1024;
pub const MAX_LANDXML_STREAM_DRAIN_BYTES: usize = 1024 * 1024;
/// The host must return transport credit by draining before more XML is read.
pub const MAX_LANDXML_STREAM_QUEUED_BYTES: usize = 512 * 1024;
pub const MAX_LANDXML_STREAM_QUEUED_EVENTS: usize = 4;
/// Maximum serialized event retained while reserving queue headroom.
pub const MAX_LANDXML_STREAM_EVENT_BYTES: usize = 192 * 1024;

struct QueuedEvent {
    event: LandXmlStreamEvent,
    serialized_bytes: usize,
}

pub struct LandXmlTinStreamSession {
    parser: Option<Parser<'static>>,
    plan: Option<crate::plan::parser::Parser<'static>>,
    alignment: Option<crate::alignment::parser::Parser<'static>>,
    pipe: Option<crate::pipe_parser::PipeParser<'static>>,
    reader: Reader<BufReader<TokenFeed>>,
    feed: TokenFeed,
    decoder: Decoder,
    token: Vec<u8>,
    kind: TokenKind,
    max_text_bytes: usize,
    max_markup_bytes: usize,
    queue: VecDeque<QueuedEvent>,
    queued_bytes: usize,
    pending_surface: Option<fragments::SurfaceCursor>,
    metadata_cursor: Option<metadata::MetadataCursor>,
    pending_input: VecDeque<u8>,
    header_emitted: bool,
    surfaces_drained: usize,
    renderable_surfaces: usize,
    preserved_surfaces: usize,
    closed: bool,
}

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
    pub fn new(limits: LandXmlLimits) -> Result<Self, LandXmlError> {
        let feed = TokenFeed::new();
        let mut reader = Reader::from_reader(BufReader::new(feed.clone()));
        reader.config_mut().trim_text(false);
        Ok(Self {
            parser: Some(Parser::new(&limits, None)),
            plan: Some(crate::plan::parser::Parser::new_stream(
                crate::LandXmlPlanLimits {
                    xml: limits.clone(),
                    ..Default::default()
                },
            )),
            alignment: Some(crate::alignment::parser::Parser::new_stream(
                crate::alignment::LandXmlAlignmentLimits {
                    xml: limits.clone(),
                    ..Default::default()
                },
            )),
            pipe: Some(crate::pipe_parser::PipeParser::new_stream(limits.clone())),
            reader,
            feed,
            decoder: Decoder::new(&limits)?,
            token: Vec::new(),
            kind: TokenKind::Text,
            max_text_bytes: limits.max_text_bytes,
            max_markup_bytes: max_markup_bytes(&limits)?,
            queue: VecDeque::new(),
            queued_bytes: 0,
            pending_surface: None,
            metadata_cursor: None,
            pending_input: VecDeque::new(),
            header_emitted: false,
            surfaces_drained: 0,
            renderable_surfaces: 0,
            preserved_surfaces: 0,
            closed: false,
        })
    }

    pub fn advance(&mut self, chunk: &[u8]) -> Result<(), LandXmlError> {
        if self.closed {
            return Err(error(
                Code::InvalidSemantic,
                "LandXML stream session is closed",
            ));
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
        self.pending_input.extend(self.decoder.push(chunk)?);
        self.consume_pending_input()?;
        Ok(())
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
        self.resume_after_drain()?;
        Ok(events)
    }

    /// Finalize parsing and begin credited metadata delivery.
    ///
    /// Call [`Self::drain`] until [`Self::output_pending`] is false. Metadata
    /// is emitted as bounded header, record, and end events without cloning
    /// the finalized family documents.
    pub fn finish_cursor(&mut self) -> Result<(), LandXmlError> {
        if self.closed {
            return Err(error(
                Code::InvalidSemantic,
                "LandXML stream session is closed",
            ));
        }
        self.decoder.finish()?;
        if self.output_pending() || !self.pending_input.is_empty() {
            return Err(error(
                Code::LimitExceeded,
                "stream output must be drained before finalization",
            ));
        }
        if !self.token.is_empty() {
            self.emit_token()?;
        }
        if self.parser().has_open_frames() {
            return Err(error(Code::InvalidXml, "unclosed XML element"));
        }
        let header = self
            .header()
            .ok_or_else(|| error(Code::InvalidSemantic, "LandXML units were not declared"))?;
        self.closed = true;
        let terrain = self.parser.take().expect("open parser").finish()?;
        let plan = self.plan.take().expect("open plan parser");
        if plan.has_open_frames() {
            return Err(error(Code::InvalidXml, "unclosed plan XML element"));
        }
        let plan = plan.document();
        let alignment = self.alignment.take().expect("open alignment parser");
        if alignment.has_open_frames() {
            return Err(error(Code::InvalidXml, "unclosed alignment XML element"));
        }
        let alignment = alignment.finish()?;
        let alignment_derived = alignment_derived_records(&alignment);
        let pipe = self.pipe.take().expect("open pipe parser");
        if pipe.has_open_frames() {
            return Err(error(Code::InvalidXml, "unclosed pipe XML element"));
        }
        let pipe = pipe.finish_stream()?;
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
            pipe_networks,
            pipe_structures,
            pipes,
            pipe_refusals,
        };
        let plan_derived = plan_derived_records(&plan)?;
        self.metadata_cursor = Some(metadata::MetadataCursor::new(
            header,
            terrain.into_stream_parts(),
            plan.into_stream_parts(),
            plan_derived,
            alignment.into_stream_parts(),
            alignment_derived,
            pipe.into_stream_parts(),
            end,
        ));
        self.flush_pending_metadata()
    }

    /// Finalize and reassemble metadata for legacy summary consumers.
    // TODO(remove-by: #5050 worker cursor migration, owner: LandXML)
    pub fn finish(&mut self) -> Result<LandXmlStreamSummary, LandXmlError> {
        self.finish_cursor()?;
        let mut reassembler = LandXmlMetadataStreamAssembler::default();
        while self.output_pending() {
            for event in self.drain(MAX_LANDXML_STREAM_DRAIN_BYTES)? {
                let LandXmlStreamEvent::Metadata(event) = event else {
                    return Err(error(
                        Code::InvalidSemantic,
                        "summary adapter received non-metadata stream output",
                    ));
                };
                reassembler.push(event)?;
            }
        }
        reassembler.finish()
    }

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
    fn parser(&mut self) -> &mut Parser<'static> {
        self.parser.as_mut().expect("open stream parser")
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

    fn consume_pending_input(&mut self) -> Result<(), LandXmlError> {
        while !self.output_pending() {
            let Some(byte) = self.pending_input.pop_front() else {
                return Ok(());
            };
            self.push_normalized(byte)?;
        }
        Ok(())
    }

    fn resume_after_drain(&mut self) -> Result<(), LandXmlError> {
        self.flush_pending_surface()?;
        self.flush_pending_metadata()?;
        self.consume_pending_input()
    }

    fn push_normalized(&mut self, byte: u8) -> Result<(), LandXmlError> {
        match &mut self.kind {
            TokenKind::Text if byte == b'<' => {
                self.emit_token()?;
                self.token.push(byte);
                self.kind = TokenKind::Markup { quote: None };
            }
            TokenKind::Text => self.token.push(byte),
            TokenKind::Markup { quote } => {
                self.token.push(byte);
                if self.token.starts_with(b"<!DOCTYPE") {
                    return Err(error(Code::DtdForbidden, "DOCTYPE is not allowed"));
                }
                let complete = if self.token.starts_with(b"<!--") {
                    self.token.ends_with(b"-->")
                } else if self.token.starts_with(b"<![CDATA[") {
                    self.token.ends_with(b"]]>")
                } else if self.token.starts_with(b"<?") {
                    self.token.ends_with(b"?>")
                } else {
                    match *quote {
                        Some(value) if byte == value => {
                            *quote = None;
                            false
                        }
                        Some(_) => false,
                        None if matches!(byte, b'\'' | b'\"') => {
                            *quote = Some(byte);
                            false
                        }
                        None => byte == b'>',
                    }
                };
                if complete {
                    self.emit_token()?;
                    self.kind = TokenKind::Text;
                }
            }
        }
        let (limit, message) = self.token_limit();
        if self.token.len() > limit {
            return Err(error(Code::LimitExceeded, message));
        }
        Ok(())
    }

    fn token_limit(&self) -> (usize, &'static str) {
        match &self.kind {
            TokenKind::Text => (self.max_text_bytes, "text limit exceeded"),
            TokenKind::Markup { .. }
                if self.token.starts_with(b"<!--") || self.token.starts_with(b"<![CDATA[") =>
            {
                (self.max_text_bytes, "XML token limit exceeded")
            }
            TokenKind::Markup { .. } => (self.max_markup_bytes, "markup limit exceeded"),
        }
    }

    fn emit_token(&mut self) -> Result<(), LandXmlError> {
        if self.token.is_empty() {
            return Ok(());
        }
        let token = std::mem::take(&mut self.token);
        let token_debug = String::from_utf8_lossy(&token).into_owned();
        let text_token = !token.starts_with(b"<");
        self.feed.push(token);
        if text_token {
            self.feed.push(b"<!--ifc-lite-stream-pad-->".to_vec());
        }
        let mut buffer = Vec::new();
        loop {
            let event = self.reader.read_event_into(&mut buffer).map_err(|value| {
                error(Code::InvalidXml, format!("malformed XML token: {value}"))
            })?;
            if matches!(event, Event::Comment(_)) {
                buffer.clear();
                continue;
            }
            if matches!(event, Event::Eof) {
                return Err(error(
                    Code::InvalidXml,
                    format!("XML reader ended while consuming token {token_debug:?}"),
                ));
            }
            self.parser().consume_event(event.clone())?;
            self.plan
                .as_mut()
                .expect("open plan parser")
                .consume_event(event.clone())?;
            self.alignment
                .as_mut()
                .expect("open alignment parser")
                .consume_event(event.clone())?;
            self.pipe
                .as_mut()
                .expect("open pipe parser")
                .consume_event(event)?;
            break;
        }
        self.emit_header_and_surfaces()
    }
}

impl Drop for LandXmlTinStreamSession {
    fn drop(&mut self) {
        self.abort();
    }
}
