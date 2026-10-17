/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! The pull read loop shared by the four family entry points (C9a-3b).

use quick_xml::{events::Event, Reader};

use super::{error, CancellationPoller, Result, TokenScanner, CANCELLATION_POLL_BYTES};
use crate::{LandXmlCancellation, LandXmlDiagnosticCode as Code, LandXmlLimits};

/// Read every event of one normalized document, in source order.
///
/// The scanner bounds every token first (cheaply, in one pass) and quick-xml
/// then reads the document up to the first token the scanner refused. A fault
/// in the scanner is therefore reported exactly where the stream would meet
/// it: after the events before it, and not before them. Errors raised by
/// `on_event` or by quick-xml in the tokens before it win.
pub(crate) fn read_events(
    input: &[u8],
    limits: &LandXmlLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
    mut on_event: impl FnMut(Event<'_>) -> Result<()>,
) -> Result<()> {
    let (valid, fault) = scan(input, limits, cancelled)?;
    let mut reader = Reader::from_reader(&input[..valid]);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|_| error(Code::InvalidXml, "malformed XML"))?;
        if matches!(event, Event::Eof) {
            break;
        }
        on_event(event)?;
        buffer.clear();
    }
    fault.map_or(Ok(()), Err)
}

/// The length of the prefix made of whole accepted tokens, and the fault
/// that ended it. Only cancellation (and an overflowing limit) is an `Err`.
fn scan(
    input: &[u8],
    limits: &LandXmlLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
) -> Result<(usize, Option<crate::LandXmlError>)> {
    let mut scanner = TokenScanner::new(limits, false)?;
    let mut poller = CancellationPoller::new(cancelled);
    poller.check()?;
    let mut at = 0;
    while at < input.len() {
        let slice = &input[at..(at + CANCELLATION_POLL_BYTES).min(input.len())];
        match scanner.next(slice) {
            Ok(step) => {
                at += step.consumed;
                poller.processed(step.consumed)?;
            }
            Err(fault) => return Ok((scanner.token_start(), Some(fault))),
        }
    }
    match scanner.finish() {
        Ok(_) => Ok((input.len(), None)),
        Err(fault) => Ok((scanner.token_start(), Some(fault))),
    }
}
