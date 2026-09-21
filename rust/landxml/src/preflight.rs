/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::{
    xml::{error, CancellationPoller, Result},
    LandXmlCancellation, LandXmlDiagnosticCode as Code, LandXmlLimits,
};

/// Bound every raw XML token before quick-xml sees it.
///
/// This is deliberately a lexical guard, not a second XML parser. It limits
/// text, comments, CDATA, processing instructions, and markup spans while
/// polling cancellation every [`crate::xml::CANCELLATION_POLL_BYTES`]. Therefore the pull
/// parser cannot spend unbounded time searching one token after this returns.
pub(crate) fn preflight_xml_tokens(
    input: &[u8],
    limits: &LandXmlLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
) -> Result<()> {
    let markup_limit = max_markup_bytes(limits)?;
    let mut poller = CancellationPoller::new(cancelled);
    poller.check()?;
    let mut index = 0;
    let mut element_depth = 0usize;
    while index < input.len() {
        if input[index] != b'<' {
            let start = index;
            scan_text(input, &mut index, limits.max_text_bytes, &mut poller)?;
            if element_depth == 0 && !input[start..index].iter().copied().all(is_xml_s) {
                return Err(error(
                    Code::InvalidXml,
                    "LandXML document has non-whitespace content outside its root element",
                ));
            }
            continue;
        }
        if input[index..].starts_with(b"<!--") {
            scan_terminated(
                input,
                &mut index,
                b"-->",
                limits.max_text_bytes,
                &mut poller,
            )?;
        } else if input[index..].starts_with(b"<![CDATA[") {
            scan_terminated(
                input,
                &mut index,
                b"]]>",
                limits.max_text_bytes,
                &mut poller,
            )?;
            if element_depth == 0 {
                return Err(error(
                    Code::InvalidXml,
                    "LandXML document has CDATA outside its root element",
                ));
            }
        } else if input[index..].starts_with(b"<?") {
            scan_terminated(input, &mut index, b"?>", markup_limit, &mut poller)?;
        } else if input[index..].starts_with(b"<!DOCTYPE") {
            // XML declarations are case-sensitive; only the uppercase token
            // is a DOCTYPE declaration. Lowercase spellings remain malformed
            // XML for quick-xml to classify without a false DTD refusal.
            return Err(error(Code::DtdForbidden, "DOCTYPE is not allowed"));
        } else {
            let start = index;
            scan_markup(input, &mut index, markup_limit, &mut poller)?;
            update_element_depth(&input[start..index], &mut element_depth);
        }
    }
    Ok(())
}

/// Track only enough XML structure to recognize raw content outside the root.
/// Quick-xml remains the authoritative parser for element names and malformed
/// markup; this lexical pass intentionally does not duplicate that grammar.
fn update_element_depth(markup: &[u8], element_depth: &mut usize) {
    if markup.starts_with(b"</") {
        *element_depth = element_depth.saturating_sub(1);
    } else if !markup.starts_with(b"<!") && !is_empty_element(markup) {
        *element_depth = element_depth.saturating_add(1);
    }
}

fn is_empty_element(markup: &[u8]) -> bool {
    markup
        .strip_suffix(b">")
        .is_some_and(|body| body.iter().rev().copied().find(|byte| !is_xml_s(*byte)) == Some(b'/'))
}

fn is_xml_s(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
}

/// Shared lexical bound for a single start/end/processing-instruction token.
/// The resumable stream applies this before forwarding data to quick-xml too.
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

fn scan_text(
    input: &[u8],
    index: &mut usize,
    limit: usize,
    poller: &mut CancellationPoller<'_>,
) -> Result<()> {
    let start = *index;
    while *index < input.len() && input[*index] != b'<' {
        advance(input, index, start, limit, poller, "text limit exceeded")?;
    }
    Ok(())
}

fn scan_terminated(
    input: &[u8],
    index: &mut usize,
    terminator: &[u8],
    limit: usize,
    poller: &mut CancellationPoller<'_>,
) -> Result<()> {
    let start = *index;
    loop {
        if input[*index..].starts_with(terminator) {
            for _ in terminator {
                advance(
                    input,
                    index,
                    start,
                    limit,
                    poller,
                    "XML token limit exceeded",
                )?;
            }
            return Ok(());
        }
        if *index == input.len() {
            return Err(error(Code::InvalidXml, "unterminated XML token"));
        }
        advance(
            input,
            index,
            start,
            limit,
            poller,
            "XML token limit exceeded",
        )?;
    }
}

fn scan_markup(
    input: &[u8],
    index: &mut usize,
    limit: usize,
    poller: &mut CancellationPoller<'_>,
) -> Result<()> {
    let start = *index;
    let mut quote = None;
    while *index < input.len() {
        let byte = input[*index];
        advance(input, index, start, limit, poller, "markup limit exceeded")?;
        match quote {
            Some(current) if byte == current => quote = None,
            Some(_) => {}
            None if matches!(byte, b'\'' | b'"') => quote = Some(byte),
            None if byte == b'>' => return Ok(()),
            None => {}
        }
    }
    Err(error(Code::InvalidXml, "unterminated XML markup"))
}

fn advance(
    input: &[u8],
    index: &mut usize,
    start: usize,
    limit: usize,
    poller: &mut CancellationPoller<'_>,
    message: &'static str,
) -> Result<()> {
    *index += 1;
    poller.processed(1)?;
    if *index - start > limit {
        return Err(error(Code::LimitExceeded, message));
    }
    debug_assert!(*index <= input.len());
    Ok(())
}
