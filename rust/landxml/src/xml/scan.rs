/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! The one lexical scanner (C9a-3b, #7784, EDGE-LXPARSE-12).
//!
//! It bounds and frames raw XML tokens before quick-xml sees them; quick-xml
//! stays the authoritative grammar (D71), so the scanner builds no events.
//! The pull entry points used to run a whole-document preflight and the
//! stream a byte-at-a-time copy of it, and the two disagreed (`<!-->x-->`
//! was a comment to one and an unterminated token to the other, and a fault
//! outside the root won over an earlier fault in the pull path only).
//!
//! The scanner owns these rules, for both paths:
//! - per-kind byte caps (`max_text_bytes` for text, comments and CDATA,
//!   `max_markup_bytes` for the rest);
//! - a comment, CDATA section or processing instruction ends at its
//!   terminator searched *after* its opener, so `<!-->` does not close;
//! - quotes inside markup (`>` in an attribute value does not end a tag);
//! - `<!DOCTYPE` is refused;
//! - outside the root only XML `S` is text and CDATA is refused.

use memchr::{memchr, memchr3};

use super::{error, is_xml_s, outside_root_error, Result};
use crate::{LandXmlDiagnosticCode as Code, LandXmlLimits};

/// What one framed token is.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TokenKind {
    Text,
    Comment,
    CData,
    Pi,
    /// A start, end, empty-element or declaration tag.
    Markup,
}

/// One call's progress: bytes consumed, and the token they completed.
pub(crate) struct Step {
    pub(crate) consumed: usize,
    pub(crate) token: Option<TokenKind>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum State {
    Text,
    /// After `<`, before the token kind is decided.
    Head,
    Comment,
    CData,
    Pi,
    Markup,
}

const OPENERS: [&[u8]; 3] = [b"<!--", b"<![CDATA[", b"<!DOCTYPE"];

pub(crate) struct TokenScanner {
    text_limit: usize,
    markup_limit: usize,
    keep: bool,
    state: State,
    /// The in-progress token's bytes, when `keep`.
    token: Vec<u8>,
    token_len: usize,
    /// Offset of the in-progress token's first byte in the whole input.
    start: usize,
    consumed: usize,
    depth: usize,
    root_seen: bool,
    /// Last two bytes of the in-progress token (terminators cross chunks).
    tail: [u8; 2],
    head: [u8; 9],
    head_len: usize,
    quote: Option<u8>,
    last_non_s: u8,
    end_tag: bool,
    declaration: bool,
}

impl TokenScanner {
    /// `keep` retains each token's bytes for [`Self::take_token`]; the pull
    /// preflight only needs the verdict.
    pub(crate) fn new(limits: &LandXmlLimits, keep: bool) -> Result<Self> {
        Ok(Self {
            text_limit: limits.max_text_bytes,
            markup_limit: max_markup_bytes(limits)?,
            keep,
            state: State::Text,
            token: Vec::new(),
            token_len: 0,
            start: 0,
            consumed: 0,
            depth: 0,
            root_seen: false,
            tail: [0; 2],
            head: [0; 9],
            head_len: 0,
            quote: None,
            last_non_s: 0,
            end_tag: false,
            declaration: false,
        })
    }

    /// Where the token that last refused (or is unfinished) begins.
    pub(crate) fn token_start(&self) -> usize {
        self.start
    }

    /// The bytes of the token the last [`Step`] completed. Hand the buffer
    /// back with [`Self::recycle`] to keep its allocation.
    pub(crate) fn take_token(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.token)
    }

    pub(crate) fn recycle(&mut self, mut buffer: Vec<u8>) {
        buffer.clear();
        if self.token.is_empty() {
            self.token = buffer;
        }
    }

    /// Scan `input` up to and including the next complete token. A token
    /// may span calls; `consumed < input.len()` only after a token.
    pub(crate) fn next(&mut self, input: &[u8]) -> Result<Step> {
        let mut at = 0;
        while at < input.len() {
            let done = match self.state {
                State::Text => self.text(input, &mut at)?,
                State::Head => self.head(input, &mut at)?,
                State::Comment => self.terminated(input, &mut at, b'-', 7, TokenKind::Comment)?,
                State::CData => self.terminated(input, &mut at, b']', 12, TokenKind::CData)?,
                State::Pi => self.terminated(input, &mut at, b'?', 3, TokenKind::Pi)?,
                State::Markup => self.markup(input, &mut at)?,
            };
            if done.is_some() {
                self.consumed += at;
                return Ok(Step { consumed: at, token: done });
            }
        }
        self.consumed += at;
        Ok(Step { consumed: at, token: None })
    }

    /// The input is complete: a trailing text token is a token, and any
    /// other unfinished token is a fault.
    pub(crate) fn finish(&mut self) -> Result<Option<TokenKind>> {
        match self.state {
            State::Text if self.token_len > 0 => {
                self.token_len = 0;
                Ok(Some(TokenKind::Text))
            }
            State::Text => Ok(None),
            State::Head | State::Markup => Err(error(Code::InvalidXml, "unterminated XML markup")),
            State::Comment | State::CData | State::Pi => {
                Err(error(Code::InvalidXml, "unterminated XML token"))
            }
        }
    }

    fn text(&mut self, input: &[u8], at: &mut usize) -> Result<Option<TokenKind>> {
        let rest = &input[*at..];
        let end = memchr(b'<', rest).unwrap_or(rest.len());
        let segment = &rest[..end];
        if self.token_len == 0 && !segment.is_empty() {
            self.start = self.consumed + *at;
            self.token.clear();
        }
        self.check_text(segment)?;
        self.append(segment);
        self.token_len += segment.len();
        *at += end;
        if end == rest.len() {
            return Ok(None);
        }
        self.state = State::Head;
        self.head_len = 0;
        // A text token ends before the `<` that opens the next one.
        Ok((self.token_len > 0).then(|| {
            self.token_len = 0;
            TokenKind::Text
        }))
    }

    /// The limit and the outside-root rule, in the order of the first
    /// offending byte, so the verdict does not depend on where the input was cut.
    fn check_text(&self, segment: &[u8]) -> Result<()> {
        let allowed = self.text_limit.saturating_sub(self.token_len);
        let outside = if self.depth == 0 { segment.iter().position(|byte| !is_xml_s(*byte)) } else { None };
        if segment.len() > allowed && outside.is_none_or(|position| position >= allowed) {
            return Err(error(Code::LimitExceeded, "text limit exceeded"));
        }
        if outside.is_some() {
            return Err(outside_root_error(self.root_seen, false));
        }
        Ok(())
    }

    fn head(&mut self, input: &[u8], at: &mut usize) -> Result<Option<TokenKind>> {
        if self.head_len == 0 {
            self.start = self.consumed + *at;
            self.token.clear();
            self.token_len = 0;
            self.quote = None;
            self.end_tag = false;
            self.declaration = false;
            self.last_non_s = b'<';
        }
        let byte = input[*at];
        *at += 1;
        self.append(&[byte]);
        self.token_len += 1;
        self.head[self.head_len] = byte;
        self.head_len += 1;
        let head = self.head;
        let head = &head[..self.head_len];
        let kind = if head == b"<!--" {
            self.state = State::Comment;
            TokenKind::Comment
        } else if head == b"<![CDATA[" {
            if self.depth == 0 {
                return Err(outside_root_error(self.root_seen, true));
            }
            self.state = State::CData;
            TokenKind::CData
        } else if head == b"<!DOCTYPE" {
            return Err(error(Code::DtdForbidden, "DOCTYPE is not allowed"));
        } else if head == b"<?" {
            self.state = State::Pi;
            TokenKind::Pi
        } else if self.head_len == 1 || OPENERS.iter().any(|opener| opener.starts_with(head)) {
            return Ok(None);
        } else {
            self.end_tag = head[1] == b'/';
            self.declaration = head[1] == b'!';
            self.state = State::Markup;
            return self.markup_byte(byte);
        };
        self.tail = [head[self.head_len.saturating_sub(2)], byte];
        self.check_len(kind)?;
        Ok(None)
    }

    /// A comment, CDATA section or processing instruction: ends at its
    /// terminator, which must start after the opener (`min` is the shortest
    /// complete token).
    fn terminated(
        &mut self,
        input: &[u8],
        at: &mut usize,
        before: u8,
        min: usize,
        kind: TokenKind,
    ) -> Result<Option<TokenKind>> {
        let rest = &input[*at..];
        let double = kind != TokenKind::Pi;
        let mut from = 0;
        let mut end = None;
        while let Some(found) = memchr(b'>', &rest[from..]) {
            let position = from + found;
            let prior = |back: usize| match position.checked_sub(back) {
                Some(index) => rest[index],
                None => self.tail[2 - (back - position)],
            };
            if self.token_len + position + 1 >= min && prior(1) == before && (!double || prior(2) == before) {
                end = Some(position + 1);
                break;
            }
            from = position + 1;
        }
        let taken = end.unwrap_or(rest.len());
        self.token_len += taken;
        self.append(&rest[..taken]);
        self.tail = match taken {
            0 => self.tail,
            1 => [self.tail[1], rest[0]],
            _ => [rest[taken - 2], rest[taken - 1]],
        };
        *at += taken;
        self.check_len(kind)?;
        if end.is_none() {
            return Ok(None);
        }
        self.state = State::Text;
        self.token_len = 0;
        Ok(Some(kind))
    }

    fn markup(&mut self, input: &[u8], at: &mut usize) -> Result<Option<TokenKind>> {
        let rest = &input[*at..];
        let mut taken = 0;
        let mut complete = false;
        while taken < rest.len() {
            let window = &rest[taken..];
            match self.quote {
                Some(quote) => match memchr(quote, window) {
                    Some(found) => {
                        taken += found + 1;
                        self.quote = None;
                    }
                    None => taken = rest.len(),
                },
                None => match memchr3(b'>', b'"', b'\'', window) {
                    Some(found) => {
                        taken += found + 1;
                        match window[found] {
                            b'>' => {
                                complete = true;
                                break;
                            }
                            quote => self.quote = Some(quote),
                        }
                    }
                    None => taken = rest.len(),
                },
            }
        }
        let body = &rest[..taken - usize::from(complete)];
        if let Some(byte) = body.iter().rev().find(|byte| !is_xml_s(**byte)) {
            self.last_non_s = *byte;
        }
        self.token_len += taken;
        self.append(&rest[..taken]);
        *at += taken;
        self.check_len(TokenKind::Markup)?;
        Ok(complete.then(|| self.close_markup()))
    }

    /// The byte that decided a `<…` token is markup, as markup input.
    fn markup_byte(&mut self, byte: u8) -> Result<Option<TokenKind>> {
        self.check_len(TokenKind::Markup)?;
        match byte {
            b'>' => Ok(Some(self.close_markup())),
            b'"' | b'\'' => {
                self.quote = Some(byte);
                Ok(None)
            }
            byte => {
                if !is_xml_s(byte) {
                    self.last_non_s = byte;
                }
                Ok(None)
            }
        }
    }

    /// Track only enough structure to recognise content outside the root.
    fn close_markup(&mut self) -> TokenKind {
        if self.end_tag {
            self.depth = self.depth.saturating_sub(1);
        } else if !self.declaration {
            self.root_seen = true;
            if self.last_non_s != b'/' {
                self.depth = self.depth.saturating_add(1);
            }
        }
        self.state = State::Text;
        self.token_len = 0;
        TokenKind::Markup
    }

    fn check_len(&self, kind: TokenKind) -> Result<()> {
        let (limit, message) = match kind {
            TokenKind::Text => (self.text_limit, "text limit exceeded"),
            TokenKind::Comment | TokenKind::CData => (self.text_limit, "XML token limit exceeded"),
            TokenKind::Pi | TokenKind::Markup => (self.markup_limit, "markup limit exceeded"),
        };
        if self.token_len > limit {
            return Err(error(Code::LimitExceeded, message));
        }
        Ok(())
    }

    fn append(&mut self, bytes: &[u8]) {
        if self.keep {
            self.token.extend_from_slice(bytes);
        }
    }
}

/// Shared lexical bound for a single start/end/processing-instruction token.
pub(crate) fn max_markup_bytes(limits: &LandXmlLimits) -> Result<usize> {
    let per_attribute = limits
        .max_name_bytes
        .checked_add(limits.max_attribute_bytes)
        .and_then(|value| value.checked_add(8))
        .ok_or_else(|| error(Code::LimitExceeded, "markup byte limit overflow"))?;
    per_attribute
        .checked_mul(limits.max_attributes)
        .and_then(|value| value.checked_add(limits.max_name_bytes))
        .and_then(|value| value.checked_add(16))
        .ok_or_else(|| error(Code::LimitExceeded, "markup byte limit overflow"))
}

#[cfg(test)]
mod tests;
