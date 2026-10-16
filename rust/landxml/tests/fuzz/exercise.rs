// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The one LandXML fuzz contract (#7680, charter G7). It is `include!`d by
// both `fuzz/fuzz_targets/parse_landxml.rs` (cargo-fuzz, nightly, scheduled
// in `.github/workflows/fuzz.yml`) and `tests/fuzz_regressions.rs` (the
// stable corpus replay in `cargo test --workspace`), so a committed corpus
// file replays through exactly the code the fuzzer ran. Plain `//` comments
// only: inner doc comments are not allowed in an included file.
//
// Contract: every public LandXML ingestion entry point, pull and stream,
// must return Ok or Err on arbitrary bytes and never panic, hang or overflow
// the stack. The stream is driven whole and one byte at a time, because its
// token loop is where one source token becomes several reader events.

use ifc_lite_landxml::{
    alignment::parse_landxml_alignments_optional, parse_landxml_document, LandXmlError,
    LandXmlLimits, LandXmlTinStreamSession, MAX_LANDXML_STREAM_DRAIN_BYTES,
};

pub fn exercise_landxml(data: &[u8]) {
    let _ = parse_landxml_document(data);
    let _ = parse_landxml_alignments_optional(data);
    let _ = stream_landxml(data, data.len().max(1));
    let _ = stream_landxml(data, 1);
    // A host that ignores every `Err` and keeps feeding (#7677): the stream
    // used to resume into frames whose builders a refused element never
    // opened. Tight limits make the refusals happen; a mid-document
    // `finish_cursor` exercises its own error paths.
    let tight = LandXmlLimits { max_pipe_structures: 0, max_pipes: 0, max_surfaces: 0, ..LandXmlLimits::default() };
    for (chunk, limits) in [(7, LandXmlLimits::default()), (7, tight.clone()), (4096, tight)] {
        stream_ignoring_errors(data, chunk, limits);
    }
}

fn stream_ignoring_errors(data: &[u8], chunk: usize, limits: LandXmlLimits) {
    let Ok(mut session) = LandXmlTinStreamSession::new(limits) else { return };
    let pieces: Vec<&[u8]> = data.chunks(chunk).collect();
    for (index, piece) in pieces.iter().enumerate() {
        let _ = drain_landxml(&mut session);
        let _ = session.advance(piece);
        if index == pieces.len() / 2 {
            let _ = session.finish_cursor();
        }
    }
    let _ = drain_landxml(&mut session);
    let _ = session.finish_cursor();
    let _ = drain_landxml(&mut session);
}

fn stream_landxml(data: &[u8], chunk: usize) -> Result<(), LandXmlError> {
    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default())?;
    for piece in data.chunks(chunk) {
        drain_landxml(&mut session)?;
        session.advance(piece)?;
    }
    drain_landxml(&mut session)?;
    session.finish().map(|_| ())
}

fn drain_landxml(session: &mut LandXmlTinStreamSession) -> Result<(), LandXmlError> {
    while session.output_pending() {
        if session.drain(MAX_LANDXML_STREAM_DRAIN_BYTES)?.is_empty() {
            break;
        }
    }
    Ok(())
}
