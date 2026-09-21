/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Bounded, encoding-aware incremental transport for canonical LandXML TIN
//! semantics.
//!
//! The driver deliberately feeds `Parser` only events produced by quick-xml.
//! It therefore shares namespace, QName, source-id, constrained-terrain and
//! diagnostic behaviour with `parse_landxml_tin_with_cancel` instead of
//! reimplementing XML matching at the transport boundary.

use std::{
    cell::RefCell,
    collections::VecDeque,
    io::{BufReader, Read},
    rc::Rc,
};

use quick_xml::{events::Event, Reader};
use serde::Serialize;

use crate::{
    parser::Parser,
    xml::{check_declared_encoding, error, Encoding},
    LandXmlDiagnosticCode as Code, LandXmlError, LandXmlLimits, LandXmlSurface, LandXmlUnits,
};

/// A source chunk is never allowed to make the worker retain an unbounded
/// postMessage payload.  `drain` further subdivides semantic records.
pub const MAX_LANDXML_STREAM_INPUT_CHUNK_BYTES: usize = 1024 * 1024;
/// Largest requested semantic drain in bytes.
pub const MAX_LANDXML_STREAM_DRAIN_BYTES: usize = 1024 * 1024;
const MAX_FRAGMENT_PAYLOAD_BYTES: usize = 192 * 1024;
const DECLARATION_BYTES: usize = 1024;

/// Facts which are safe to publish only after root namespace and units were
/// validated by the canonical parser.
#[derive(Clone, Debug, Serialize)]
pub struct LandXmlStreamHeader {
    pub version: String,
    pub units: LandXmlUnits,
}

/// Typed portions of a surface.  Consumers reassemble records by
/// `(source_id, component, sequence)`; a component is never a renderer id.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandXmlSurfaceComponent {
    Start,
    Points,
    CanonicalVertices,
    SourceDataPoints,
    Faces,
    Boundaries,
    Breaklines,
    Contours,
    End,
}

/// A bounded byte fragment of one typed semantic component. `payload_utf8`
/// contains JSON record bytes. It may end between records only when a single
/// source record itself exceeds the drain cap; `continued` then makes that
/// explicit rather than rejecting an otherwise valid large surface.
#[derive(Clone, Debug, Serialize)]
pub struct LandXmlSurfaceFragment {
    pub source_id: String,
    pub component: LandXmlSurfaceComponent,
    pub sequence: usize,
    pub continued: bool,
    pub payload_utf8: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LandXmlStreamEvent {
    Header(LandXmlStreamHeader),
    Surface(LandXmlSurfaceFragment),
}

/// Bounded final facts, intentionally not a fake complete `LandXmlTinDocument`.
/// Surface payloads were already drained; metadata families remain owned by
/// their specialised complete-document APIs until they gain equivalent event
/// sinks.
#[derive(Clone, Debug, Serialize)]
pub struct LandXmlStreamSummary {
    pub header: LandXmlStreamHeader,
    pub surfaces_drained: usize,
    pub renderable_surfaces: usize,
    pub preserved_surfaces: usize,
}

enum TokenKind {
    Text,
    Markup { quote: Option<u8> },
}

/// A one-token-at-a-time byte source for quick-xml.  The `Reader` retains its
/// authoritative element stack across calls, while the transport scanner
/// ensures it is never asked to interpret an incomplete token as EOF.
#[derive(Clone)]
struct TokenFeed(Rc<RefCell<VecDeque<u8>>>);

impl TokenFeed {
    fn new() -> Self {
        Self(Rc::new(RefCell::new(VecDeque::new())))
    }
    fn push(&self, bytes: Vec<u8>) {
        self.0.borrow_mut().extend(bytes);
    }
}

impl Read for TokenFeed {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let mut bytes = self.0.borrow_mut();
        let length = output.len().min(bytes.len());
        for target in &mut output[..length] {
            *target = bytes.pop_front().expect("length bounded");
        }
        Ok(length)
    }
}

/// Owned decoder state. Raw input and normalised output each have independent
/// quotas, and UTF-16 code units/surrogates can span arbitrary transport cuts.
struct Decoder {
    encoding: Option<Encoding>,
    undecided: Vec<u8>,
    utf16_tail: Option<u8>,
    high_surrogate: Option<u16>,
    declaration: Vec<u8>,
    raw_seen: usize,
    normalized_seen: usize,
    max_raw: usize,
    max_normalized: usize,
}

impl Decoder {
    fn new(limits: &LandXmlLimits) -> Result<Self, LandXmlError> {
        let max_normalized = limits
            .max_bytes
            .checked_mul(3)
            .and_then(|value| value.checked_div(2))
            .ok_or_else(|| error(Code::LimitExceeded, "normalized byte limit overflow"))?;
        Ok(Self {
            encoding: None,
            undecided: Vec::new(),
            utf16_tail: None,
            high_surrogate: None,
            declaration: Vec::new(),
            raw_seen: 0,
            normalized_seen: 0,
            max_raw: limits.max_bytes,
            max_normalized,
        })
    }

    fn push(&mut self, chunk: &[u8]) -> Result<Vec<u8>, LandXmlError> {
        self.raw_seen = self
            .raw_seen
            .checked_add(chunk.len())
            .ok_or_else(|| error(Code::InputTooLarge, "input exceeds byte limit"))?;
        if self.raw_seen > self.max_raw {
            return Err(error(Code::InputTooLarge, "input exceeds byte limit"));
        }
        self.undecided.extend_from_slice(chunk);
        self.detect()?;
        let Some(encoding) = self.encoding else {
            return Ok(Vec::new());
        };
        let pending = std::mem::take(&mut self.undecided);
        let output = match encoding {
            Encoding::Utf8 => self.decode_utf8(&pending)?,
            Encoding::Utf16Le | Encoding::Utf16Be => self.decode_utf16(&pending, encoding)?,
        };
        self.account(&output)?;
        Ok(output)
    }

    fn finish(&mut self) -> Result<(), LandXmlError> {
        self.detect()?;
        if self.encoding.is_none() {
            return Err(error(Code::InvalidXml, "LandXML document is empty"));
        }
        if !self.undecided.is_empty() {
            return Err(error(Code::InvalidXml, "input is not valid UTF-8"));
        }
        if self.utf16_tail.is_some() {
            return Err(error(
                Code::InvalidXml,
                "UTF-16 input has an odd byte length",
            ));
        }
        if self.high_surrogate.is_some() {
            return Err(error(Code::InvalidXml, "input is not valid UTF-16"));
        }
        check_declared_encoding(&self.declaration, self.encoding.expect("checked encoding"))
    }

    fn detect(&mut self) -> Result<(), LandXmlError> {
        if self.encoding.is_some() || self.undecided.is_empty() {
            return Ok(());
        }
        let bytes = &self.undecided;
        let (encoding, skip) = match bytes.as_slice() {
            [0xef, 0xbb, 0xbf, ..] => (Encoding::Utf8, 3),
            [0xff, 0xfe, ..] => (Encoding::Utf16Le, 2),
            [0xfe, 0xff, ..] => (Encoding::Utf16Be, 2),
            [b'<', 0, ..] => (Encoding::Utf16Le, 0),
            [0, b'<', ..] => (Encoding::Utf16Be, 0),
            [0xef] | [0xef, 0xbb] | [0xff] | [0xfe] | [b'<'] | [0] => return Ok(()),
            _ => (Encoding::Utf8, 0),
        };
        self.undecided.drain(..skip);
        self.encoding = Some(encoding);
        Ok(())
    }

    fn decode_utf8(&mut self, input: &[u8]) -> Result<Vec<u8>, LandXmlError> {
        // Retain at most three trailing bytes, so a scalar may cross chunks.
        let complete = match std::str::from_utf8(input) {
            Ok(_) => input.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(_) => return Err(error(Code::InvalidXml, "input is not valid UTF-8")),
        };
        let output = input[..complete].to_vec();
        self.undecided.extend_from_slice(&input[complete..]);
        Ok(output)
    }

    fn decode_utf16(&mut self, input: &[u8], encoding: Encoding) -> Result<Vec<u8>, LandXmlError> {
        let mut bytes = Vec::with_capacity(input.len() + usize::from(self.utf16_tail.is_some()));
        if let Some(tail) = self.utf16_tail.take() {
            bytes.push(tail);
        }
        bytes.extend_from_slice(input);
        if bytes.len() % 2 == 1 {
            self.utf16_tail = bytes.pop();
        }
        let mut output = String::new();
        for pair in bytes.chunks_exact(2) {
            let unit = match encoding {
                Encoding::Utf16Le => u16::from_le_bytes([pair[0], pair[1]]),
                Encoding::Utf16Be => u16::from_be_bytes([pair[0], pair[1]]),
                Encoding::Utf8 => unreachable!(),
            };
            if let Some(high) = self.high_surrogate.take() {
                if !(0xdc00..=0xdfff).contains(&unit) {
                    return Err(error(Code::InvalidXml, "input is not valid UTF-16"));
                }
                let scalar = 0x1_0000 + (u32::from(high - 0xd800) << 10) + u32::from(unit - 0xdc00);
                output.push(
                    char::from_u32(scalar)
                        .ok_or_else(|| error(Code::InvalidXml, "input is not valid UTF-16"))?,
                );
            } else if (0xd800..=0xdbff).contains(&unit) {
                self.high_surrogate = Some(unit);
            } else if (0xdc00..=0xdfff).contains(&unit) {
                return Err(error(Code::InvalidXml, "input is not valid UTF-16"));
            } else {
                output.push(char::from_u32(u32::from(unit)).expect("valid non-surrogate scalar"));
            }
        }
        Ok(output.into_bytes())
    }

    fn account(&mut self, output: &[u8]) -> Result<(), LandXmlError> {
        self.normalized_seen = self
            .normalized_seen
            .checked_add(output.len())
            .ok_or_else(|| error(Code::LimitExceeded, "normalized byte limit exceeded"))?;
        if self.normalized_seen > self.max_normalized {
            return Err(error(Code::LimitExceeded, "normalized byte limit exceeded"));
        }
        if self.declaration.len() < DECLARATION_BYTES {
            let remaining = DECLARATION_BYTES - self.declaration.len();
            self.declaration
                .extend_from_slice(&output[..output.len().min(remaining)]);
        }
        Ok(())
    }
}

/// Resumable semantic driver. `advance` accepts arbitrary raw byte cuts;
/// callers repeatedly call `drain` to honour the renderer's actual credits.
pub struct LandXmlTinStreamSession {
    parser: Option<Parser<'static>>,
    reader: Reader<BufReader<TokenFeed>>,
    feed: TokenFeed,
    decoder: Decoder,
    token: Vec<u8>,
    kind: TokenKind,
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
            reader,
            feed,
            decoder: Decoder::new(&limits)?,
            token: Vec::new(),
            kind: TokenKind::Text,
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
        // Run final semantic resolution (including roadway references) using
        // the retained tiny name index, then deliberately drop its remainder.
        self.parser.take().expect("open parser").finish()?;
        Ok(LandXmlStreamSummary {
            header,
            surfaces_drained: self.surfaces_drained,
            renderable_surfaces: self.renderable_surfaces,
            preserved_surfaces: self.preserved_surfaces,
        })
    }

    pub fn abort(&mut self) {
        self.token.clear();
        self.queue.clear();
        self.parser.take();
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
        if self.token.len() > self.parser().max_text_bytes() {
            return Err(error(Code::LimitExceeded, "XML token exceeds byte limit"));
        }
        Ok(())
    }

    fn emit_token(&mut self) -> Result<(), LandXmlError> {
        if self.token.is_empty() {
            return Ok(());
        }
        let token = std::mem::take(&mut self.token);
        let token_debug = String::from_utf8_lossy(&token).into_owned();
        let text_token = !token.starts_with(b"<");
        self.feed.push(token);
        // A text event otherwise makes `Reader` observe transport EOF while
        // looking ahead for the next '<'.  A harmless XML comment gives it a
        // real delimiter without ever asking it to parse an incomplete tag.
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
            self.parser().consume_event(event)?;
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
        let source_id = surface.source_id.0.clone();
        #[derive(Serialize)]
        struct Start<'a> {
            ordinal: usize,
            source_path: &'a str,
            properties: &'a crate::LandXmlProperties,
            definition_properties: &'a crate::LandXmlProperties,
            name: &'a str,
            kind: crate::LandXmlSurfaceKind,
            render_state: crate::LandXmlRenderState,
            topology_origin: crate::LandXmlTopologyOrigin,
            terrain_diagnostic: &'a Option<crate::LandXmlTerrainDiagnostic>,
            hidden_face_count: usize,
        }
        self.enqueue_json(
            &source_id,
            LandXmlSurfaceComponent::Start,
            &Start {
                ordinal: surface.ordinal,
                source_path: &surface.source_path,
                properties: &surface.properties,
                definition_properties: &surface.definition_properties,
                name: &surface.name,
                kind: surface.kind,
                render_state: surface.render_state,
                topology_origin: surface.topology_origin,
                terrain_diagnostic: &surface.terrain_diagnostic,
                hidden_face_count: surface.hidden_face_count,
            },
        )?;
        self.enqueue_records(&source_id, LandXmlSurfaceComponent::Points, surface.points)?;
        self.enqueue_records(
            &source_id,
            LandXmlSurfaceComponent::CanonicalVertices,
            surface.canonical_vertices,
        )?;
        self.enqueue_records(
            &source_id,
            LandXmlSurfaceComponent::SourceDataPoints,
            surface.source_data_points,
        )?;
        #[derive(Serialize)]
        struct Face {
            ids: [String; 3],
            source_id: crate::LandXmlSourceId,
            visible: bool,
        }
        let faces = surface
            .faces
            .into_iter()
            .enumerate()
            .map(|(index, ids)| Face {
                ids,
                source_id: surface.face_source_ids[index].clone(),
                visible: surface.face_visibility[index],
            })
            .collect::<Vec<_>>();
        self.enqueue_records(&source_id, LandXmlSurfaceComponent::Faces, faces)?;
        self.enqueue_records(
            &source_id,
            LandXmlSurfaceComponent::Boundaries,
            surface.boundaries,
        )?;
        self.enqueue_records(
            &source_id,
            LandXmlSurfaceComponent::Breaklines,
            surface.breaklines,
        )?;
        self.enqueue_records(
            &source_id,
            LandXmlSurfaceComponent::Contours,
            surface.contours,
        )?;
        self.queue
            .push_back(LandXmlStreamEvent::Surface(LandXmlSurfaceFragment {
                source_id,
                component: LandXmlSurfaceComponent::End,
                sequence: 0,
                continued: false,
                payload_utf8: Vec::new(),
            }));
        Ok(())
    }

    fn enqueue_json<T: Serialize>(
        &mut self,
        source_id: &str,
        component: LandXmlSurfaceComponent,
        value: &T,
    ) -> Result<(), LandXmlError> {
        self.enqueue_bytes(
            source_id,
            component,
            serde_json::to_vec(value).map_err(|value| {
                error(
                    Code::InvalidSemantic,
                    format!("stream serialization failed: {value}"),
                )
            })?,
        )
    }
    fn enqueue_records<T: Serialize>(
        &mut self,
        source_id: &str,
        component: LandXmlSurfaceComponent,
        values: Vec<T>,
    ) -> Result<(), LandXmlError> {
        for value in values {
            self.enqueue_json(source_id, component, &value)?;
        }
        Ok(())
    }
    fn enqueue_bytes(
        &mut self,
        source_id: &str,
        component: LandXmlSurfaceComponent,
        bytes: Vec<u8>,
    ) -> Result<(), LandXmlError> {
        for (sequence, payload_utf8) in bytes.chunks(MAX_FRAGMENT_PAYLOAD_BYTES).enumerate() {
            self.queue
                .push_back(LandXmlStreamEvent::Surface(LandXmlSurfaceFragment {
                    source_id: source_id.to_owned(),
                    component,
                    sequence,
                    continued: (sequence + 1) * MAX_FRAGMENT_PAYLOAD_BYTES < bytes.len(),
                    payload_utf8: payload_utf8.to_vec(),
                }));
        }
        Ok(())
    }
}

impl Drop for LandXmlTinStreamSession {
    fn drop(&mut self) {
        self.abort();
    }
}
