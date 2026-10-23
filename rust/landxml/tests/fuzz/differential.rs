// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The pull-vs-stream differential (C9a-0, #7784, D78). `include!`d by
// `tests/fuzz/exercise.rs`, so the scheduled fuzz target, the corpus replay in
// `tests/fuzz_regressions.rs` and `tests/landxml_differential.rs` all run the
// same comparison. Plain `//` comments only (included file).
//
// Contract: the four pull entry points and the streaming session are one
// parser fed two ways, so for any bytes and limits they must agree on
//   1. Ok versus Err (a stream is Ok iff every pull family is Ok);
//   2. the error code, whenever the failing pull families agree on one (two
//      families refusing for different reasons are ordered by source position
//      in the stream and by family in the pull API, so no single code exists);
//   3. when Ok, terrain, plan and alignments equal as typed values (a stricter
//      test than equal serde JSON), the surface points equal as JSON, and the
//      pipe totals, at every chunk size. The fuzz crate has no serde of its
//      own, so `cfg(fuzzing)` builds skip the surface-point JSON comparison.

use ifc_lite_landxml::{
    alignment::{
        parse_landxml_alignments_optional_with_cancel, LandXmlAlignmentDocument,
        LandXmlAlignmentLimits,
    },
    parse_landxml_pipe_networks_with_cancel, parse_landxml_plan_with_cancel,
    parse_landxml_tin_with_cancel, LandXmlDiagnosticCode, LandXmlPipeNetworkDocument,
    LandXmlPlanDocument, LandXmlPlanLimits, LandXmlStreamEvent, LandXmlStreamSummary,
    LandXmlTinDocument,
};
#[cfg(not(fuzzing))]
use ifc_lite_landxml::LandXmlSurfaceComponent;

/// Which part of the contract broke. The fuzz target fails on `Outcome` and
/// `Output`; `Code` is also pinned by the replay tests, but two classes of
/// double-fault input still differ in code and a fuzzer finds them every
/// run: bytes that are not valid UTF-8 or UTF-16 (pull refuses the whole
/// input first, the stream the chunk holding them) and a numeric TIN surface
/// without `<Units>` (pull checks at the end, the stream when it completes).
/// The scanner's own order (content outside the root, limits, DOCTYPE, an
/// unterminated token) agrees since C9a-3b.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DivergenceKind {
    Outcome,
    Code,
    Output,
}

#[derive(Clone, Debug)]
pub struct Divergence {
    pub kind: DivergenceKind,
    pub detail: String,
}

/// Chunk sizes for the stream: one byte, a size that cuts tokens at odd
/// places, and a size larger than most documents.
pub const DIFFERENTIAL_CHUNKS: [usize; 3] = [1, 7, 4096];

#[cfg(not(fuzzing))]
fn json<T: serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).expect("serializable")
}

fn stream_with(
    data: &[u8],
    chunk: usize,
    limits: &LandXmlLimits,
) -> Result<(Vec<LandXmlStreamEvent>, LandXmlStreamSummary), LandXmlError> {
    let mut session = LandXmlTinStreamSession::new(limits.clone())?;
    let mut events = Vec::new();
    for piece in data.chunks(chunk) {
        drain_into(&mut session, &mut events)?;
        session.advance(piece)?;
    }
    drain_into(&mut session, &mut events)?;
    let summary = session.finish()?;
    Ok((events, summary))
}

fn drain_into(
    session: &mut LandXmlTinStreamSession,
    events: &mut Vec<LandXmlStreamEvent>,
) -> Result<(), LandXmlError> {
    while session.output_pending() {
        events.extend(session.drain(MAX_LANDXML_STREAM_DRAIN_BYTES)?);
    }
    Ok(())
}

/// Every streamed point, in document order. A point arrives as one JSON value
/// that may be split over continued fragments.
#[cfg(not(fuzzing))]
fn streamed_points(events: &[LandXmlStreamEvent]) -> Vec<serde_json::Value> {
    let mut points = Vec::new();
    let mut pending = Vec::new();
    for event in events {
        let LandXmlStreamEvent::Surface(fragment) = event else { continue };
        if fragment.component != LandXmlSurfaceComponent::Points {
            continue;
        }
        pending.extend_from_slice(&fragment.payload_utf8);
        if !fragment.continued {
            points.push(serde_json::from_slice(&pending).expect("point JSON"));
            pending.clear();
        }
    }
    points
}

/// What the four pull entry points make of the same bytes.
pub struct Pull {
    pub tin: Result<LandXmlTinDocument, LandXmlError>,
    pub plan: Result<LandXmlPlanDocument, LandXmlError>,
    pub alignments: Result<LandXmlAlignmentDocument, LandXmlError>,
    pub pipes: Result<Option<LandXmlPipeNetworkDocument>, LandXmlError>,
}

impl Pull {
    pub fn run(data: &[u8], limits: &LandXmlLimits) -> Self {
        let plan_limits = LandXmlPlanLimits { xml: limits.clone(), ..Default::default() };
        let alignment_limits = LandXmlAlignmentLimits { xml: limits.clone(), ..Default::default() };
        let pipes = match parse_landxml_pipe_networks_with_cancel(data, limits, None) {
            // The pull API requires a PipeNetwork; the stream treats it as optional.
            Err(error)
                if error.code == LandXmlDiagnosticCode::InvalidSemantic
                    && error.message == "document contains no PipeNetwork records" =>
            {
                Ok(None)
            }
            other => other.map(Some),
        };
        Self {
            tin: parse_landxml_tin_with_cancel(data, limits, None),
            plan: parse_landxml_plan_with_cancel(data, &plan_limits, None),
            alignments: parse_landxml_alignments_optional_with_cancel(data, &alignment_limits, None),
            pipes,
        }
    }

    /// The distinct codes of the families that refused.
    pub fn codes(&self) -> Vec<LandXmlDiagnosticCode> {
        let mut codes: Vec<LandXmlDiagnosticCode> = [
            self.tin.as_ref().err(),
            self.plan.as_ref().err(),
            self.alignments.as_ref().err(),
            self.pipes.as_ref().err(),
        ]
        .into_iter()
        .flatten()
        .map(|error| error.code)
        .collect();
        codes.sort_by_key(|code| format!("{code:?}"));
        codes.dedup();
        codes
    }
}

/// Whether the stream accepts `data`, fed in `chunk`-byte pieces.
pub fn stream_accepts(data: &[u8], chunk: usize, limits: &LandXmlLimits) -> bool {
    stream_with(data, chunk, limits).is_ok()
}

/// Compare the pull parsers with the stream at every chunk size in
/// [`DIFFERENTIAL_CHUNKS`].
pub fn differential_landxml(data: &[u8], limits: &LandXmlLimits) -> Result<(), Divergence> {
    let pull = Pull::run(data, limits);
    let codes = pull.codes();
    for chunk in DIFFERENTIAL_CHUNKS {
        let streamed = stream_with(data, chunk, limits);
        let diverged = |kind, detail: String| Divergence { kind, detail: format!("chunk {chunk}: {detail}") };
        if !codes.is_empty() {
            let Err(error) = &streamed else {
                return Err(diverged(
                    DivergenceKind::Outcome,
                    format!("pull refused with {codes:?} but the stream accepted"),
                ));
            };
            if codes.len() == 1 && error.code != codes[0] {
                return Err(diverged(
                    DivergenceKind::Code,
                    format!("pull {:?} vs stream {:?} ({})", codes[0], error.code, error.message),
                ));
            }
            continue;
        }
        let (events, summary) = match streamed {
            Ok(value) => value,
            Err(error) => {
                return Err(diverged(
                    DivergenceKind::Outcome,
                    format!("pull accepted but the stream refused: {:?} {}", error.code, error.message),
                ))
            }
        };
        let (Ok(tin), Ok(plan), Ok(alignments), Ok(pipes)) = (&pull.tin, &pull.plan, &pull.alignments, &pull.pipes)
        else {
            unreachable!("no pull family refused");
        };
        let mut terrain = tin.clone();
        let surfaces = std::mem::take(&mut terrain.surfaces);
        // `parse_landxml_document` attaches the pipe family to the terrain
        // document, and so does the stream's metadata.
        terrain.pipe_networks = pipes.clone();
        let (pipe_networks, pipe_structures, pipe_count, pipe_refusals) = pipes.as_ref().map_or((0, 0, 0, 0), |pipes| {
            (
                pipes.networks.len(),
                pipes.networks.iter().map(|network| network.structures.len()).sum::<usize>(),
                pipes.networks.iter().map(|network| network.pipes.len()).sum::<usize>(),
                pipes.refusals.len(),
            )
        });
        #[cfg(not(fuzzing))]
        let surface_points_equal = {
            let points: Vec<serde_json::Value> =
                surfaces.iter().flat_map(|surface| surface.points.iter().map(json)).collect();
            streamed_points(&events) == points
        };
        #[cfg(fuzzing)]
        let surface_points_equal = {
            let _ = &events;
            true
        };
        let checks: [(&str, bool); 7] = [
            ("terrain", summary.metadata.terrain == terrain),
            ("plan", summary.metadata.plan == *plan),
            ("alignments", summary.metadata.alignments == *alignments),
            ("surface points", surface_points_equal),
            ("surface count", summary.surfaces_drained == surfaces.len()),
            ("header version", summary.header.version == tin.version),
            (
                "pipe totals",
                (summary.pipe_networks, summary.pipe_structures, summary.pipes, summary.pipe_refusals)
                    == (pipe_networks, pipe_structures, pipe_count, pipe_refusals),
            ),
        ];
        if let Some((name, _)) = checks.iter().find(|(_, equal)| !equal) {
            return Err(diverged(DivergenceKind::Output, format!("{name} differs between pull and stream")));
        }
    }
    Ok(())
}
