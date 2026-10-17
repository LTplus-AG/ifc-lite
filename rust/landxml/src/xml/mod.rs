/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::collections::HashMap;

use quick_xml::events::BytesStart;

mod budget;
mod driver;
mod element;
mod encoding;
mod pull;
mod refs;
mod scan;
pub(crate) use budget::{poll, Budget, Meter};
pub(crate) use encoding::{normalize_encoding, Decoder};
pub(crate) use driver::{drive, path_is_of, Cx, Driver, Element, FamilyHandler};
pub(crate) use pull::read_events;
pub(crate) use scan::{TokenKind, TokenScanner};
pub(crate) use refs::{decode_ref, decode_text, source_len};

use crate::{LandXmlCancellation, LandXmlDiagnosticCode as Code, LandXmlError, LandXmlLimits};

pub(crate) type Result<T> = std::result::Result<T, LandXmlError>;
pub(crate) type Attributes = Vec<(String, String)>;
pub(crate) type Namespaces = HashMap<String, String>;

/// Maximum raw bytes processed between cooperative cancellation checks.
///
/// Normalization and the preflight scanner use this bound before quick-xml is
/// invoked. The scanner also refuses a token larger than its documented
/// semantic limit, so quick-xml never gets an unbounded single token to scan.
pub(crate) const CANCELLATION_POLL_BYTES: usize = 4 * 1024;

pub(crate) struct CancellationPoller<'a> {
    cancelled: Option<&'a dyn LandXmlCancellation>,
    since_check: usize,
}

impl<'a> CancellationPoller<'a> {
    pub(crate) fn new(cancelled: Option<&'a dyn LandXmlCancellation>) -> Self {
        Self {
            cancelled,
            since_check: 0,
        }
    }

    pub(crate) fn check(&mut self) -> Result<()> {
        poll(self.cancelled)?;
        self.since_check = 0;
        Ok(())
    }

    pub(crate) fn processed(&mut self, mut bytes: usize) -> Result<()> {
        while bytes > 0 {
            let until_check = CANCELLATION_POLL_BYTES - self.since_check;
            let processed = bytes.min(until_check);
            self.since_check += processed;
            bytes -= processed;
            if self.since_check == CANCELLATION_POLL_BYTES {
                self.check()?;
            }
        }
        Ok(())
    }
}

pub(crate) fn attributes(
    start: &BytesStart<'_>,
    limits: &LandXmlLimits,
    char_refs: &mut Budget,
) -> Result<(Attributes, Namespaces)> {
    let mut values = Vec::new();
    let mut namespaces = HashMap::new();
    let mut count = Budget::new(limits.max_attributes, "attribute");
    for attribute in start.attributes().with_checks(true) {
        let attribute = attribute.map_err(|_| error(Code::InvalidXml, "invalid XML attribute"))?;
        count.reserve(1)?;
        let key = utf8(
            attribute.key.as_ref().as_bytes(),
            limits.max_name_bytes,
            "attribute name",
        )?
        .to_owned();
        let raw_value = utf8(
            attribute.value.as_ref().as_bytes(),
            limits.max_attribute_bytes,
            "attribute value",
        )?;
        let value = decode_text(raw_value, char_refs)?.into_owned();
        if key == "xmlns" {
            namespaces.insert(String::new(), value.clone());
        } else if let Some(prefix) = key.strip_prefix("xmlns:") {
            namespaces.insert(prefix.to_owned(), value.clone());
        }
        values.push((key, value));
    }
    Ok((values, namespaces))
}

pub(crate) fn attr<'a>(attributes: &'a Attributes, key: &str) -> Option<&'a str> {
    attributes
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
}

pub(crate) fn required<'a>(
    attributes: &'a Attributes,
    key: &str,
    context: &str,
) -> Result<&'a str> {
    attr(attributes, key)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| error(Code::InvalidSemantic, format!("{context} is missing {key}")))
}

pub(crate) fn split_name(bytes: &[u8], max: usize) -> Result<(&str, &str, &str)> {
    let raw = utf8(bytes, max, "element name")?;
    let (prefix, local) = raw
        .split_once(':')
        .map_or(("", raw), |(prefix, local)| (prefix, local));
    Ok((raw, local, prefix))
}

pub(crate) fn utf8<'a>(bytes: &'a [u8], max: usize, context: &str) -> Result<&'a str> {
    if bytes.len() > max {
        return Err(error(
            Code::LimitExceeded,
            format!("{context} limit exceeded"),
        ));
    }
    std::str::from_utf8(bytes)
        .map_err(|_| error(Code::InvalidXml, format!("invalid UTF-8 {context}")))
}

/// XML production [3] `S`: the only bytes allowed between markup outside the
/// document element.
pub(crate) fn is_xml_s(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
}

/// The one rule for character data outside the document element: XML `S`
/// bytes only, never CDATA, and never a reference (`&#32;` cannot pass for
/// padding), so every family and the stream refuse the same bytes.
pub(crate) fn outside_root_text(root_closed: bool, text: &str, cdata: bool) -> Result<()> {
    if !cdata && text.bytes().all(is_xml_s) {
        return Ok(());
    }
    Err(outside_root_error(root_closed, cdata))
}

pub(crate) fn outside_root_error(root_closed: bool, cdata: bool) -> LandXmlError {
    let location = if root_closed { "after" } else { "before" };
    let kind = if cdata { "CDATA" } else { "non-whitespace content" };
    error(
        Code::InvalidXml,
        format!("LandXML document has {kind} {location} its root element"),
    )
}

pub(crate) fn error(code: Code, message: impl Into<String>) -> LandXmlError {
    LandXmlError::new(code, message)
}
