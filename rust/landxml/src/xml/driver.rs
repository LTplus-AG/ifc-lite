/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! The one XML event driver (C9a-5, #7784, EDGE-LXPARSE-1; D70).
//!
//! Four families used to carry their own copy of everything between a
//! quick-xml event and the family's records: the event loop, the work charge,
//! the depth cap, the name split, the attribute and namespace handling, the
//! root checks, the text rules and the end-of-document checks. The driver is
//! that front end once. A family implements [`FamilyHandler`] and sees only
//! decoded start tags, ends, and the text of the element it is capturing; it
//! never matches a quick-xml event. Pull ([`drive`]) and the stream both feed
//! [`Driver::event`], so every semantic transition is shared by construction.
//!
//! Streaming, not a DOM: no tree is built. Nesting is a `Vec` stack capped by
//! `max_depth`, breadth is bounded by the work budget, and every refusal is a
//! hard `Err` naming its limit.

use std::rc::Rc;

use quick_xml::events::{BytesRef, BytesStart, Event};

use super::{
    attributes, decode_ref, decode_text, error, outside_root_text, read_events, source_len, split_name,
    Attributes, Budget, Meter, Result,
};
use crate::{
    parser::validate_root, LandXmlCancellation, LandXmlCapabilityDiagnostic, LandXmlDiagnosticCode as Code,
    LandXmlLimits,
};

pub(crate) use super::element::{Element, Frame};

/// What every family reads from the document element, validated once.
pub(crate) struct RootInfo {
    pub(crate) schema: String,
    pub(crate) version: String,
    pub(crate) target_namespace: Option<String>,
    /// The compatibility diagnostic a version mismatch earns; each family
    /// records it against its own diagnostic budget.
    pub(crate) diagnostic: Option<LandXmlCapabilityDiagnostic>,
    /// The raw attributes of `LandXML/Units/{Metric,Imperial}`, once. Each
    /// family converts them with its own scale table until C9b (D75).
    pub(crate) units: Option<Attributes>,
}

/// The driver's state, as a family sees it while handling one event.
pub(crate) struct Cx<'d> {
    pub(crate) root: &'d RootInfo,
    frames: &'d [Frame],
}

impl Cx<'_> {
    /// Open elements, outermost first; the last is the one being handled.
    pub(crate) fn frames(&self) -> &[Frame] {
        self.frames
    }

    /// Whether the open elements are exactly `expected`, all in the root
    /// namespace. The one `is_path`.
    pub(crate) fn path_is(&self, expected: &[&str]) -> bool {
        path_is(self.frames, expected)
    }
}

fn path_is(frames: &[Frame], expected: &[&str]) -> bool {
    path_is_of(frames.iter().map(|frame| (&*frame.local, frame.target)), expected)
}

/// The one `is_path`: the open elements, as `(local name, in the root
/// namespace)`, are exactly `expected`. A family that keeps frames of its own
/// asks the same question of them.
pub(crate) fn path_is_of<'f>(open: impl ExactSizeIterator<Item = (&'f str, bool)>, expected: &[&str]) -> bool {
    open.len() == expected.len() && open.zip(expected).all(|((local, target), name)| target && local == *name)
}

/// A family's view of a document. Implementations never see quick-xml events.
pub(crate) trait FamilyHandler {
    /// Refuse a start tag nested in what the family is capturing, before the
    /// driver reads it (D74); the family chooses its own granularity.
    fn check_nesting(&mut self, _depth: usize) -> Result<()> {
        Ok(())
    }
    fn start(&mut self, cx: &Cx<'_>, element: &Element<'_>) -> Result<()>;
    /// The element on top of `cx.frames()` is closing.
    fn end(&mut self, cx: &Cx<'_>) -> Result<()>;
    /// Only called when [`Self::capture_depth`] is `Some(depth)` for the
    /// element the text is in; `text` is decoded, and CDATA is literal.
    fn text(&mut self, cx: &Cx<'_>, text: &str) -> Result<()>;
    fn capture_depth(&self) -> Option<usize>;
}

pub(crate) struct Driver<'a> {
    limits: LandXmlLimits,
    meter: Meter<'a>,
    character_references: Budget,
    frames: Vec<Frame>,
    root: Option<RootInfo>,
    root_closed: bool,
}

type Handlers<'h, 'x> = &'h mut [&'x mut dyn FamilyHandler];

impl<'a> Driver<'a> {
    /// `meter` is the document's one work budget, shared with the handlers.
    pub(crate) fn new(limits: &LandXmlLimits, meter: Meter<'a>) -> Self {
        Self {
            limits: limits.clone(),
            meter,
            character_references: Budget::new(limits.max_character_references, "character reference"),
            frames: Vec::new(),
            root: None,
            root_closed: false,
        }
    }

    /// Process one event: charge work, then dispatch.
    pub(crate) fn event(&mut self, event: Event<'_>, handlers: Handlers<'_, '_>) -> Result<()> {
        self.meter.charge(1)?;
        match event {
            Event::Start(start) => self.start(&start, handlers),
            Event::Empty(start) => {
                self.start(&start, handlers)?;
                self.end(handlers)
            }
            Event::End(_) => self.end(handlers),
            Event::Text(text) => self.text(text.as_ref().as_bytes(), handlers),
            // #7680: a reference in text arrives as its own event.
            Event::GeneralRef(reference) => self.reference(&reference, handlers),
            Event::CData(text) => self.cdata(text.as_ref().as_bytes(), handlers),
            Event::DocType(_) => Err(error(Code::DtdForbidden, "DOCTYPE is not allowed")),
            _ => Ok(()),
        }
    }

    /// The document is complete: it must have a root, and it must be closed.
    pub(crate) fn finish(self) -> Result<RootInfo> {
        let Some(root) = self.root else {
            return Err(error(Code::InvalidXml, "LandXML document is empty"));
        };
        if !self.frames.is_empty() || !self.root_closed {
            return Err(error(Code::InvalidXml, "unclosed XML element"));
        }
        Ok(root)
    }

    fn start(&mut self, start: &BytesStart<'_>, handlers: Handlers<'_, '_>) -> Result<()> {
        for handler in handlers.iter_mut() {
            handler.check_nesting(self.frames.len())?;
        }
        if self.frames.len() >= self.limits.max_depth {
            return Err(error(Code::LimitExceeded, "XML depth limit exceeded"));
        }
        let name = start.name();
        let (_, local, prefix) = split_name(name.as_ref().as_bytes(), self.limits.max_name_bytes)?;
        let (attributes, declared) = attributes(start, &self.limits, &mut self.character_references)?;
        self.meter.charge(attributes.len())?;
        let namespaces = match (self.frames.last(), declared.is_empty()) {
            (Some(parent), true) => Rc::clone(&parent.namespaces),
            (Some(parent), false) => {
                let mut inherited = (*parent.namespaces).clone();
                inherited.extend(declared);
                Rc::new(inherited)
            }
            (None, _) => Rc::new(declared),
        };
        let namespace = namespaces.get(prefix).map(String::as_str);
        if self.frames.is_empty() {
            let root = validate_root(self.root.is_some(), local, namespace, &attributes)?;
            self.root = Some(RootInfo {
                schema: root.schema,
                version: root.version,
                target_namespace: namespace.map(str::to_owned),
                diagnostic: root.diagnostic,
                units: None,
            });
        }
        let root = self.root.as_mut().expect("the root start sets it");
        let target = namespace == root.target_namespace.as_deref();
        self.frames.push(Frame { local: Rc::from(local), target, namespaces: Rc::clone(&namespaces) });
        // The one "declared only once" for `LandXML/Units/{Metric,Imperial}`.
        if matches!(local, "Metric" | "Imperial") && path_is(&self.frames, &["LandXML", "Units", local]) {
            if root.units.is_some() {
                return Err(error(Code::InvalidSemantic, "LandXML may declare units only once"));
            }
            root.units = Some(attributes.clone());
        }
        let element = Element {
            local,
            namespace,
            target,
            depth: self.frames.len(),
            attributes: &attributes,
        };
        let cx = Cx { root, frames: &self.frames };
        handlers.iter_mut().try_for_each(|handler| handler.start(&cx, &element))
    }

    fn end(&mut self, handlers: Handlers<'_, '_>) -> Result<()> {
        let Some(root) = self.root.as_ref().filter(|_| !self.frames.is_empty()) else {
            return Err(error(Code::InvalidXml, "unexpected closing element"));
        };
        // quick-xml has already matched this end tag to its start tag.
        let cx = Cx { root, frames: &self.frames };
        handlers.iter_mut().try_for_each(|handler| handler.end(&cx))?;
        if self.frames.len() == 1 {
            self.root_closed = true;
        }
        self.frames.pop();
        Ok(())
    }

    fn text(&mut self, bytes: &[u8], handlers: Handlers<'_, '_>) -> Result<()> {
        let raw = self.text_bytes(bytes)?;
        if self.frames.is_empty() {
            return outside_root_text(self.root_closed, raw, false);
        }
        let text = decode_text(raw, &mut self.character_references)?;
        self.capture(&text, handlers)
    }

    /// A `&name;` in element content, decoded straight from the event.
    fn reference(&mut self, reference: &BytesRef<'_>, handlers: Handlers<'_, '_>) -> Result<()> {
        let source = source_len(reference);
        if source > self.limits.max_text_bytes {
            return Err(error(Code::LimitExceeded, "text limit exceeded"));
        }
        self.meter.charge(source)?;
        // `&#32;` cannot pass for padding outside the document element.
        if self.frames.is_empty() {
            return outside_root_text(self.root_closed, "&", false);
        }
        let character = decode_ref(reference, &mut self.character_references)?;
        self.capture(character.encode_utf8(&mut [0; 4]), handlers)
    }

    /// CDATA is literal character data: never decoded.
    fn cdata(&mut self, bytes: &[u8], handlers: Handlers<'_, '_>) -> Result<()> {
        let literal = self.text_bytes(bytes)?;
        if self.frames.is_empty() {
            return outside_root_text(self.root_closed, literal, true);
        }
        self.capture(literal, handlers)
    }

    fn text_bytes<'b>(&mut self, bytes: &'b [u8]) -> Result<&'b str> {
        if bytes.len() > self.limits.max_text_bytes {
            return Err(error(Code::LimitExceeded, "text limit exceeded"));
        }
        self.meter.charge(bytes.len())?;
        std::str::from_utf8(bytes).map_err(|_| error(Code::InvalidXml, "text is not UTF-8"))
    }

    /// Hand `text` to each family that is capturing the open element.
    fn capture(&self, text: &str, handlers: Handlers<'_, '_>) -> Result<()> {
        let depth = self.frames.len();
        let cx = Cx { root: self.root.as_ref().expect("text is inside the root"), frames: &self.frames };
        handlers
            .iter_mut()
            .filter(|handler| handler.capture_depth() == Some(depth))
            .try_for_each(|handler| handler.text(&cx, text))
    }
}

/// Pull: read every event of one normalized document through the handlers.
pub(crate) fn drive(
    input: &[u8],
    limits: &LandXmlLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
    meter: Meter<'_>,
    handlers: Handlers<'_, '_>,
) -> Result<RootInfo> {
    let mut driver = Driver::new(limits, meter);
    read_events(input, limits, cancelled, |event| driver.event(event, handlers))?;
    driver.finish()
}

#[cfg(test)]
mod tests;
