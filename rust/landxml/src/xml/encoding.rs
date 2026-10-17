/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! The one input decoder (C9a-3a, #7784, EDGE-LXPARSE-11).
//!
//! LandXML ingestion accepts only UTF-8 and UTF-16. The pull entry points and
//! the stream session used to carry two copies of the byte-order-mark table,
//! the UTF-16 decoding, the normalized-size bound and the 1024-byte
//! declaration window. [`Decoder`] is the incremental one: a code unit, a
//! surrogate pair or a UTF-8 sequence may cross any chunk boundary. The pull
//! path is [`normalize_encoding`], which is `push` over bounded slices
//! followed by `finish`.

use super::{error, Budget, CancellationPoller, Result, CANCELLATION_POLL_BYTES};
use crate::{LandXmlCancellation, LandXmlDiagnosticCode as Code, LandXmlLimits};

const DECLARATION_BYTES: usize = 1024;

#[derive(Clone, Copy, Eq, PartialEq)]
enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

/// Normalize the XML's supported encodings before its pull parser sees bytes.
///
/// The input and normalized output stay bounded by `max_bytes` and its UTF-16
/// expansion bound, and cancellation is polled every
/// [`CANCELLATION_POLL_BYTES`].
pub(crate) fn normalize_encoding(
    input: &[u8],
    limits: &LandXmlLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
) -> Result<Vec<u8>> {
    let mut poller = CancellationPoller::new(cancelled);
    poller.check()?;
    let mut decoder = Decoder::new(limits)?;
    let mut normalized = Vec::with_capacity(input.len());
    for chunk in input.chunks(CANCELLATION_POLL_BYTES) {
        decoder.push_into(chunk, &mut normalized)?;
        poller.check()?;
    }
    normalized.extend(decoder.finish()?);
    Ok(normalized)
}

/// Raw input and normalized output have independent quotas.
pub(crate) struct Decoder {
    encoding: Option<Encoding>,
    undecided: Vec<u8>,
    utf16_tail: Option<u8>,
    high_surrogate: Option<u16>,
    /// Output withheld until the XML declaration (if any) has been judged.
    held: Vec<u8>,
    declaration_checked: bool,
    finished: bool,
    raw: Budget,
    normalized: Budget,
}

impl Decoder {
    pub(crate) fn new(limits: &LandXmlLimits) -> Result<Self> {
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
            held: Vec::new(),
            declaration_checked: false,
            finished: false,
            raw: Budget::input_bytes(limits.max_bytes),
            normalized: Budget::new(max_normalized, "normalized byte"),
        })
    }

    /// Decode one chunk; the stream hands back what it can decode so far.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<Vec<u8>> {
        let mut output = Vec::with_capacity(chunk.len());
        self.push_into(chunk, &mut output)?;
        Ok(output)
    }

    /// [`Self::push`], appending to `output`.
    pub(crate) fn push_into(&mut self, chunk: &[u8], output: &mut Vec<u8>) -> Result<()> {
        self.raw.reserve(chunk.len())?;
        let start = output.len();
        match self.encoding {
            Some(encoding) if self.undecided.is_empty() => {
                self.decode(chunk, encoding, output)?;
            }
            _ => {
                // Undecided: the byte-order mark is still incomplete, or the
                // last chunk ended inside a UTF-8 sequence.
                self.undecided.extend_from_slice(chunk);
                self.detect(false);
                let Some(encoding) = self.encoding else {
                    return Ok(());
                };
                let pending = std::mem::take(&mut self.undecided);
                self.decode(&pending, encoding, output)?;
            }
        }
        self.normalized.reserve(output.len() - start)?;
        self.settle_declaration(output, start, false)
    }

    /// The input is complete: refuse a truncated sequence or a bad
    /// `encoding` declaration, and release the output still withheld for it
    /// to `output`. A second call does nothing.
    pub(crate) fn finish(&mut self) -> Result<Vec<u8>> {
        let mut output = Vec::new();
        if !std::mem::replace(&mut self.finished, true) {
            self.finish_into(&mut output)?;
        }
        Ok(output)
    }

    fn finish_into(&mut self, output: &mut Vec<u8>) -> Result<()> {
        let start = output.len();
        // A prefix of a byte-order mark that the input never completed is
        // ordinary content (and invalid UTF-8 or UTF-8 text, as it is).
        if self.encoding.is_none() && !self.undecided.is_empty() {
            self.detect(true);
            let pending = std::mem::take(&mut self.undecided);
            let encoding = self.encoding.expect("detected at end of input");
            self.decode(&pending, encoding, output)?;
            self.normalized.reserve(output.len() - start)?;
        }
        if self.encoding.is_none() {
            return Err(error(Code::InvalidXml, "LandXML document is empty"));
        }
        if !self.undecided.is_empty() {
            return Err(error(Code::InvalidXml, "input is not valid UTF-8"));
        }
        if self.utf16_tail.is_some() {
            return Err(error(Code::InvalidXml, "UTF-16 input has an odd byte length"));
        }
        if self.high_surrogate.is_some() {
            return Err(error(Code::InvalidXml, "input is not valid UTF-16"));
        }
        self.settle_declaration(output, start, true)
    }

    /// The declared `encoding` is judged as soon as the declaration is
    /// complete (or its 1 KiB window is full, or the input ends), and the
    /// output before that verdict is withheld. Pull and stream therefore
    /// report a bad declaration ahead of any later fault in the same place.
    fn settle_declaration(&mut self, output: &mut Vec<u8>, start: usize, end: bool) -> Result<()> {
        if self.declaration_checked {
            return Ok(());
        }
        self.held.extend(output.drain(start..));
        let window = &self.held[..self.held.len().min(DECLARATION_BYTES)];
        let judged = match declaration_state(window) {
            Declaration::Absent => true,
            Declaration::Incomplete => end,
            Declaration::Open => {
                end || window.len() == DECLARATION_BYTES || window.windows(2).any(|pair| pair == b"?>")
            }
        };
        if judged {
            let encoding = self.encoding.expect("output implies a detected encoding");
            check_declared_encoding(&self.held, encoding)?;
            self.declaration_checked = true;
            output.append(&mut self.held);
        }
        Ok(())
    }

    fn detect(&mut self, end_of_input: bool) {
        if self.encoding.is_some() || self.undecided.is_empty() {
            return;
        }
        let (encoding, skip) = match self.undecided.as_slice() {
            [0xef, 0xbb, 0xbf, ..] => (Encoding::Utf8, 3),
            [0xff, 0xfe, ..] => (Encoding::Utf16Le, 2),
            [0xfe, 0xff, ..] => (Encoding::Utf16Be, 2),
            [b'<', 0, ..] => (Encoding::Utf16Le, 0),
            [0, b'<', ..] => (Encoding::Utf16Be, 0),
            [0xef] | [0xef, 0xbb] | [0xff] | [0xfe] | [b'<'] | [0] if !end_of_input => return,
            _ => (Encoding::Utf8, 0),
        };
        self.undecided.drain(..skip);
        self.encoding = Some(encoding);
    }

    fn decode(&mut self, input: &[u8], encoding: Encoding, output: &mut Vec<u8>) -> Result<()> {
        match encoding {
            Encoding::Utf8 => self.decode_utf8(input, output),
            Encoding::Utf16Le | Encoding::Utf16Be => self.decode_utf16(input, encoding, output),
        }
    }

    fn decode_utf8(&mut self, input: &[u8], output: &mut Vec<u8>) -> Result<()> {
        let complete = match std::str::from_utf8(input) {
            Ok(_) => input.len(),
            Err(value) if value.error_len().is_none() => value.valid_up_to(),
            Err(_) => return Err(error(Code::InvalidXml, "input is not valid UTF-8")),
        };
        output.extend_from_slice(&input[..complete]);
        self.undecided.extend_from_slice(&input[complete..]);
        Ok(())
    }

    fn decode_utf16(&mut self, input: &[u8], encoding: Encoding, output: &mut Vec<u8>) -> Result<()> {
        let mut input = input;
        if let Some(low) = self.utf16_tail.take() {
            let Some((&high, rest)) = input.split_first() else {
                self.utf16_tail = Some(low);
                return Ok(());
            };
            input = rest;
            self.unit(unit_of([low, high], encoding), output)?;
        }
        let pairs = input.chunks_exact(2);
        self.utf16_tail = pairs.remainder().first().copied();
        for pair in pairs {
            self.unit(unit_of([pair[0], pair[1]], encoding), output)?;
        }
        Ok(())
    }

    fn unit(&mut self, unit: u16, output: &mut Vec<u8>) -> Result<()> {
        let invalid = || error(Code::InvalidXml, "input is not valid UTF-16");
        let scalar = if let Some(high) = self.high_surrogate.take() {
            if !(0xdc00..=0xdfff).contains(&unit) {
                return Err(invalid());
            }
            0x1_0000 + (u32::from(high - 0xd800) << 10) + u32::from(unit - 0xdc00)
        } else if (0xd800..=0xdbff).contains(&unit) {
            self.high_surrogate = Some(unit);
            return Ok(());
        } else if (0xdc00..=0xdfff).contains(&unit) {
            return Err(invalid());
        } else {
            u32::from(unit)
        };
        let character = char::from_u32(scalar).ok_or_else(invalid)?;
        output.extend_from_slice(character.encode_utf8(&mut [0; 4]).as_bytes());
        Ok(())
    }

}

enum Declaration {
    /// The document does not open with `<?xml` and whitespace.
    Absent,
    /// So far a prefix of `<?xml` and whitespace.
    Incomplete,
    /// `<?xml` and whitespace: an XML declaration that may not be complete.
    Open,
}

fn declaration_state(window: &[u8]) -> Declaration {
    const OPEN: &[u8] = b"<?xml";
    if window.len() <= OPEN.len() {
        return if OPEN.starts_with(window) { Declaration::Incomplete } else { Declaration::Absent };
    }
    if window.starts_with(OPEN) && window[OPEN.len()].is_ascii_whitespace() {
        Declaration::Open
    } else {
        Declaration::Absent
    }
}

fn unit_of(pair: [u8; 2], encoding: Encoding) -> u16 {
    match encoding {
        Encoding::Utf16Be => u16::from_be_bytes(pair),
        _ => u16::from_le_bytes(pair),
    }
}

fn check_declared_encoding(input: &[u8], detected: Encoding) -> Result<()> {
    const DECLARATION_LIMIT: usize = 1024;
    let prefix = &input[..input.len().min(DECLARATION_LIMIT)];
    // The window can end inside a multi-byte character. Read the valid
    // prefix rather than treating the whole window as "no declaration",
    // which let padding skip the encoding refusal (EDGE-LXPARSE-23, #7693).
    let declaration = match std::str::from_utf8(prefix) {
        Ok(prefix) => Some(prefix),
        Err(invalid) => std::str::from_utf8(&prefix[..invalid.valid_up_to()]).ok(),
    }
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


#[cfg(test)]
mod tests;
