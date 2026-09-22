/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Encoding normalization owned by the incremental transport boundary.

use crate::{
    xml::{check_declared_encoding, error, Encoding},
    LandXmlDiagnosticCode as Code, LandXmlError, LandXmlLimits,
};

const DECLARATION_BYTES: usize = 1024;

/// Raw input and normalized output have independent quotas. UTF-16 code units
/// and surrogate pairs may cross arbitrary source chunks.
pub(super) struct Decoder {
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
    pub(super) fn new(limits: &LandXmlLimits) -> Result<Self, LandXmlError> {
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

    pub(super) fn push(&mut self, chunk: &[u8]) -> Result<Vec<u8>, LandXmlError> {
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

    pub(super) fn finish(&mut self) -> Result<(), LandXmlError> {
        self.detect()?;
        let Some(encoding) = self.encoding else {
            return Err(error(Code::InvalidXml, "LandXML document is empty"));
        };
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
        check_declared_encoding(&self.declaration, encoding)
    }

    fn detect(&mut self) -> Result<(), LandXmlError> {
        if self.encoding.is_some() || self.undecided.is_empty() {
            return Ok(());
        }
        let (encoding, skip) = match self.undecided.as_slice() {
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
        let complete = match std::str::from_utf8(input) {
            Ok(_) => input.len(),
            Err(value) if value.error_len().is_none() => value.valid_up_to(),
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
