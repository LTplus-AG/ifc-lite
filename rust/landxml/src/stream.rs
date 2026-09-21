/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

mod decoder;
mod event;
mod fragments;
mod token;

use crate::{
    parser::Parser, preflight::max_markup_bytes, xml::error, LandXmlDiagnosticCode as Code,
    LandXmlError, LandXmlLimits, LandXmlSurface,
};
use decoder::Decoder;
pub use event::{
    LandXmlStreamEvent, LandXmlStreamHeader, LandXmlStreamSummary, LandXmlSurfaceComponent,
    LandXmlSurfaceFragment,
};
use quick_xml::{events::Event, Reader};
use std::{collections::VecDeque, io::BufReader};
use token::{TokenFeed, TokenKind};

pub const MAX_LANDXML_STREAM_INPUT_CHUNK_BYTES: usize = 1024 * 1024;
pub const MAX_LANDXML_STREAM_DRAIN_BYTES: usize = 1024 * 1024;

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
    queue: VecDeque<LandXmlStreamEvent>,
    header_emitted: bool,
    surfaces_drained: usize,
    renderable_surfaces: usize,
    preserved_surfaces: usize,
    closed: bool,
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
        for byte in self.decoder.push(chunk)? {
            self.push_normalized(byte)?;
        }
        Ok(())
    }

    pub fn drain(&mut self, max_bytes: usize) -> Result<Vec<LandXmlStreamEvent>, LandXmlError> {
        if max_bytes == 0 || max_bytes > MAX_LANDXML_STREAM_DRAIN_BYTES {
            return Err(error(Code::LimitExceeded, "invalid stream drain budget"));
        }
        let mut bytes = 0usize;
        let mut events = Vec::new();
        while let Some(event) = self.queue.front() {
            let size = serde_json::to_vec(event)
                .map_err(|value| {
                    error(
                        Code::InvalidSemantic,
                        format!("stream serialization failed: {value}"),
                    )
                })?
                .len();
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
            events.push(self.queue.pop_front().expect("front checked"));
        }
        Ok(events)
    }

    pub fn finish(&mut self) -> Result<LandXmlStreamSummary, LandXmlError> {
        if self.closed {
            return Err(error(
                Code::InvalidSemantic,
                "LandXML stream session is closed",
            ));
        }
        self.decoder.finish()?;
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
        self.parser.take().expect("open parser").finish()?;
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
        let pipe = self.pipe.take().expect("open pipe parser");
        if pipe.has_open_frames() {
            return Err(error(Code::InvalidXml, "unclosed pipe XML element"));
        }
        let pipe = pipe.finish_stream()?;
        Ok(LandXmlStreamSummary {
            header,
            surfaces_drained: self.surfaces_drained,
            renderable_surfaces: self.renderable_surfaces,
            preserved_surfaces: self.preserved_surfaces,
            plan_cogo_points: plan.cogo_points.len(),
            plan_parcels: plan.parcels.len(),
            horizontal_alignments: alignment.alignments.len(),
            pipe_networks: pipe.networks.len(),
            pipe_structures: pipe
                .networks
                .iter()
                .map(|network| network.structures.len())
                .sum(),
            pipes: pipe
                .networks
                .iter()
                .map(|network| network.pipes.len())
                .sum(),
            pipe_refusals: pipe.refusals.len(),
        })
    }

    pub fn abort(&mut self) {
        self.token.clear();
        self.queue.clear();
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

    fn emit_header_and_surfaces(&mut self) -> Result<(), LandXmlError> {
        if !self.header_emitted {
            if let Some(header) = self.header() {
                self.queue.push_back(LandXmlStreamEvent::Header(header));
                self.header_emitted = true;
            }
        }
        for surface in self.parser().take_surfaces() {
            self.enqueue_surface(surface)?;
        }
        Ok(())
    }

    fn enqueue_surface(&mut self, surface: LandXmlSurface) -> Result<(), LandXmlError> {
        self.surfaces_drained += 1;
        if surface.render_state == crate::LandXmlRenderState::Rendered {
            self.renderable_surfaces += 1;
        } else {
            self.preserved_surfaces += 1;
        }
        fragments::enqueue_surface(&mut self.queue, surface)
    }
}

impl Drop for LandXmlTinStreamSession {
    fn drop(&mut self) {
        self.abort();
    }
}
