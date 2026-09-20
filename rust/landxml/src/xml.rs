/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::{collections::HashMap, str};

use quick_xml::events::BytesStart;

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
        if self
            .cancelled
            .is_some_and(LandXmlCancellation::is_cancelled)
        {
            return Err(error(Code::Cancelled, "ingestion cancelled"));
        }
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
) -> Result<(Attributes, Namespaces, usize)> {
    let mut values = Vec::new();
    let mut namespaces = HashMap::new();
    let mut references = 0;
    for attribute in start.attributes().with_checks(true) {
        let attribute = attribute.map_err(|_| error(Code::InvalidXml, "invalid XML attribute"))?;
        if values.len() >= limits.max_attributes {
            return Err(error(Code::LimitExceeded, "attribute limit exceeded"));
        }
        let key = utf8(
            attribute.key.as_ref(),
            limits.max_name_bytes,
            "attribute name",
        )?
        .to_owned();
        let raw_value = utf8(
            attribute.value.as_ref(),
            limits.max_attribute_bytes,
            "attribute value",
        )?;
        references += character_references(raw_value);
        let value = unescape(raw_value)?;
        if key == "xmlns" {
            namespaces.insert(String::new(), value.clone());
        } else if let Some(prefix) = key.strip_prefix("xmlns:") {
            namespaces.insert(prefix.to_owned(), value.clone());
        }
        values.push((key, value));
    }
    Ok((values, namespaces, references))
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

pub(crate) fn character_references(value: &str) -> usize {
    value.bytes().filter(|byte| *byte == b'&').count()
}

pub(crate) fn unescape(value: &str) -> Result<String> {
    quick_xml::escape::unescape(value)
        .map(|decoded| decoded.into_owned())
        .map_err(|_| error(Code::EntityForbidden, "unknown XML entity reference"))
}

/// Normalize the XML's supported encodings before its pull parser sees bytes.
///
/// LandXML ingestion deliberately accepts only UTF-8 and UTF-16. The input and
/// normalized output stay bounded by `max_bytes` and its UTF-16 expansion bound.
pub(crate) fn normalize_encoding(
    input: &[u8],
    limits: &LandXmlLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
) -> Result<Vec<u8>> {
    let mut poller = CancellationPoller::new(cancelled);
    poller.check()?;
    let (encoding, payload) = match input {
        [0xef, 0xbb, 0xbf, rest @ ..] => (Encoding::Utf8, rest),
        [0xff, 0xfe, rest @ ..] => (Encoding::Utf16Le, rest),
        [0xfe, 0xff, rest @ ..] => (Encoding::Utf16Be, rest),
        [b'<', 0, ..] => (Encoding::Utf16Le, input),
        [0, b'<', ..] => (Encoding::Utf16Be, input),
        _ => (Encoding::Utf8, input),
    };
    let normalized = match encoding {
        Encoding::Utf8 => decode_utf8(payload, &mut poller)?,
        Encoding::Utf16Le | Encoding::Utf16Be => decode_utf16(payload, encoding, &mut poller)?,
    };
    let max_normalized = limits
        .max_bytes
        .checked_mul(3)
        .and_then(|value| value.checked_div(2))
        .ok_or_else(|| error(Code::LimitExceeded, "normalized byte limit overflow"))?;
    if normalized.len() > max_normalized {
        return Err(error(Code::LimitExceeded, "normalized byte limit exceeded"));
    }
    check_declared_encoding(&normalized, encoding)?;
    Ok(normalized)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

fn decode_utf8(input: &[u8], poller: &mut CancellationPoller<'_>) -> Result<Vec<u8>> {
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        let mut end = (index + CANCELLATION_POLL_BYTES).min(input.len());
        while end > index && end < input.len() && (input[end] & 0b1100_0000) == 0b1000_0000 {
            end -= 1;
        }
        // A valid chunk always starts on a code-point boundary, so rewinding
        // cannot consume the whole chunk. If it does, the input starts with
        // (or contains a run of) continuation bytes. Refuse it rather than
        // validating an empty slice and retrying the same index forever.
        if end == index {
            return Err(error(Code::InvalidXml, "input is not valid UTF-8"));
        }
        let chunk = &input[index..end];
        std::str::from_utf8(chunk)
            .map_err(|_| error(Code::InvalidXml, "input is not valid UTF-8"))?;
        output.extend_from_slice(chunk);
        poller.processed(chunk.len())?;
        index = end;
    }
    Ok(output)
}

fn decode_utf16(
    input: &[u8],
    encoding: Encoding,
    poller: &mut CancellationPoller<'_>,
) -> Result<Vec<u8>> {
    if !input.len().is_multiple_of(2) {
        return Err(error(
            Code::InvalidXml,
            "UTF-16 input has an odd byte length",
        ));
    }
    let mut output = String::new();
    let mut index = 0;
    while index < input.len() {
        let unit = utf16_unit(input, index, encoding);
        index += 2;
        poller.processed(2)?;
        let scalar = match unit {
            0xd800..=0xdbff => {
                if index == input.len() {
                    return Err(error(Code::InvalidXml, "input is not valid UTF-16"));
                }
                let low = utf16_unit(input, index, encoding);
                index += 2;
                poller.processed(2)?;
                if !(0xdc00..=0xdfff).contains(&low) {
                    return Err(error(Code::InvalidXml, "input is not valid UTF-16"));
                }
                0x1_0000 + (u32::from(unit - 0xd800) << 10) + u32::from(low - 0xdc00)
            }
            0xdc00..=0xdfff => return Err(error(Code::InvalidXml, "input is not valid UTF-16")),
            unit => u32::from(unit),
        };
        let character = char::from_u32(scalar)
            .ok_or_else(|| error(Code::InvalidXml, "input is not valid UTF-16"))?;
        output.push(character);
    }
    Ok(output.into_bytes())
}

fn utf16_unit(input: &[u8], index: usize, encoding: Encoding) -> u16 {
    let pair = [input[index], input[index + 1]];
    match encoding {
        Encoding::Utf16Le => u16::from_le_bytes(pair),
        Encoding::Utf16Be => u16::from_be_bytes(pair),
        Encoding::Utf8 => unreachable!("UTF-8 does not use UTF-16 decoding"),
    }
}

fn check_declared_encoding(input: &[u8], detected: Encoding) -> Result<()> {
    const DECLARATION_LIMIT: usize = 1024;
    let declaration = input
        .get(..input.len().min(DECLARATION_LIMIT))
        .and_then(|prefix| str::from_utf8(prefix).ok())
        .filter(|prefix| {
            prefix
                .strip_prefix("<?xml")
                .is_some_and(|rest| rest.as_bytes().first().is_some_and(u8::is_ascii_whitespace))
        });
    let Some(declaration) = declaration else {
        return Ok(());
    };
    let Some(end) = declaration.find("?>") else {
        return Err(error(Code::InvalidXml, "unterminated XML declaration"));
    };
    let declaration = &declaration[..end];
    let lower = declaration.to_ascii_lowercase();
    let Some(position) = lower.find("encoding") else {
        return Ok(());
    };
    let value = declaration[position + "encoding".len()..].trim_start();
    let Some(value) = value.strip_prefix('=') else {
        return Err(error(
            Code::InvalidXml,
            "malformed XML encoding declaration",
        ));
    };
    let value = value.trim_start();
    let Some(quote) = value
        .chars()
        .next()
        .filter(|quote| matches!(quote, '\'' | '"'))
    else {
        return Err(error(
            Code::InvalidXml,
            "malformed XML encoding declaration",
        ));
    };
    let Some(end_quote) = value[quote.len_utf8()..].find(quote) else {
        return Err(error(
            Code::InvalidXml,
            "malformed XML encoding declaration",
        ));
    };
    let declared = &value[quote.len_utf8()..quote.len_utf8() + end_quote];
    let supported = match declared.to_ascii_lowercase().as_str() {
        "utf-8" | "utf8" => detected == Encoding::Utf8,
        "utf-16" => detected != Encoding::Utf8,
        "utf-16le" => detected == Encoding::Utf16Le,
        "utf-16be" => detected == Encoding::Utf16Be,
        _ => false,
    };
    if supported {
        Ok(())
    } else {
        Err(error(
            Code::InvalidXml,
            "unsupported XML encoding declaration",
        ))
    }
}

pub(crate) fn error(code: Code, message: impl Into<String>) -> LandXmlError {
    LandXmlError::new(code, message)
}
