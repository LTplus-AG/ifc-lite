/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! #7677: LandXML input that reached a panic. The release profile is
//! `panic = 'abort'`, so in the browser each of these trapped the wasm
//! instance instead of returning a refusal.
//!
//! - A streaming session kept accepting input after a refused element. Each
//!   family parser pushes its frame before the element handler runs, so the
//!   next tag reached an `expect` on a builder that was never opened (the
//!   wasm `advanceChunk` keeps the session after an `Err`).
//! - An irregular line whose Start and End are within 2·EPSILON of each other
//!   sliced its interior points with a reversed range.

use ifc_lite_landxml::alignment::{
    LandXmlAlignment, LandXmlAlignmentPrimitive, LandXmlAlignmentSegment, LandXmlIrregularLine,
    LandXmlPlanPoint, LandXmlPointLocation,
};
use ifc_lite_landxml::{
    LandXmlError, LandXmlLimits, LandXmlSourceId, LandXmlTinStreamSession, MAX_LANDXML_STREAM_DRAIN_BYTES,
};

const HEAD: &str = r#"<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units>"#;

/// Feed `chunk` and grant output credit the way a host does.
fn feed(session: &mut LandXmlTinStreamSession, chunk: &str) -> Result<(), LandXmlError> {
    session.advance(chunk.as_bytes())?;
    while session.output_pending() {
        session.drain(MAX_LANDXML_STREAM_DRAIN_BYTES)?;
    }
    Ok(())
}

/// Feed `first`, which must be refused, then keep feeding `rest` the way a
/// host that ignores the error would. Every later call must be a refusal too.
fn resume_after_refusal(limits: LandXmlLimits, first: &str, rest: &[&str]) {
    let mut session = LandXmlTinStreamSession::new(limits).expect("session");
    // A trailing space lets the tokenizer finish the last tag of the chunk.
    let refused = feed(&mut session, &format!("{HEAD}{first} "));
    assert!(refused.is_err(), "{first:?} must be refused");
    for chunk in rest {
        let resumed = feed(&mut session, &format!("{chunk} "));
        assert!(resumed.is_err(), "{chunk:?} after a refusal must be refused, not resumed");
    }
    assert!(session.finish().is_err(), "a refused session cannot finish");
}

#[test]
fn issue_7677_stream_does_not_resume_into_a_pipe_network_that_never_opened() {
    let bad = r#"<PipeNetworks><PipeNetwork name="n" pipeNetType="bogus">"#;
    resume_after_refusal(LandXmlLimits::default(), bad, &["<Structs>", "<Struct name=\"A\">"]);
    resume_after_refusal(LandXmlLimits::default(), bad, &["<Pipes>", "<Pipe name=\"P\">"]);
    resume_after_refusal(LandXmlLimits::default(), bad, &["</PipeNetwork>"]);
}

#[test]
fn issue_7677_stream_does_not_resume_into_a_refused_structure_or_pipe() {
    let limits = LandXmlLimits { max_pipe_structures: 0, max_pipes: 0, ..LandXmlLimits::default() };
    let network = r#"<PipeNetworks><PipeNetwork name="n" pipeNetType="storm">"#;
    resume_after_refusal(limits.clone(), &format!("{network}<Structs><Struct name=\"A\">"), &["<Center>0 0 0</Center>"]);
    resume_after_refusal(limits.clone(), &format!("{network}<Structs><Struct name=\"A\">"), &["</Struct>"]);
    resume_after_refusal(limits.clone(), &format!("{network}<Pipes><Pipe name=\"P\">"), &["<CircPipe diameter=\"1\"/>"]);
    resume_after_refusal(limits, &format!("{network}<Pipes><Pipe name=\"P\">"), &["</Pipe>"]);
}

#[test]
fn issue_7677_stream_does_not_resume_into_a_surface_without_a_name() {
    resume_after_refusal(LandXmlLimits::default(), "<Surfaces><Surface>", &["</Surface>"]);
}

fn point(northing: f64, easting: f64) -> LandXmlPlanPoint {
    LandXmlPlanPoint { northing, easting, elevation: None }
}

#[test]
fn issue_7677_irregular_line_with_near_coincident_ends_does_not_slice_backwards() {
    let at = |p: LandXmlPlanPoint| LandXmlPointLocation::Coordinates { point: p };
    let segment = LandXmlAlignmentSegment {
        source_id: LandXmlSourceId("landxml:alignment:1:segment:1".to_owned()),
        ordinal: 1,
        primitive: LandXmlAlignmentPrimitive::IrregularLine(LandXmlIrregularLine {
            start: at(point(0.0, 0.0)),
            end: at(point(0.0, 1.5e-9)),
            // The first point past EPSILON from Start is index 2 and the last
            // one past EPSILON from End is index 0, so the scans cross.
            points: vec![point(0.0, -0.5e-9), point(0.0, 0.75e-9)],
            declared_length: None,
        }),
    };
    let alignment = LandXmlAlignment {
        source_id: LandXmlSourceId("landxml:alignment:1:main".to_owned()),
        ordinal: 1,
        name: "main".to_owned(),
        length: 1.0,
        sta_start: 0.0,
        start: None,
        align_pis: Vec::new(),
        segments: vec![segment],
        station_equations: Vec::new(),
        cant: None,
        superelevations: Vec::new(),
        unsupported_transitions: Vec::new(),
    };
    // The declared length disagrees with the ~1.5e-9 m polyline, so the probe
    // is refused; it used to panic measuring that polyline first.
    let refused = alignment.probe_at_distance(0.0, 1.0).map(|_| ()).expect_err("inconsistent length");
    assert_eq!(refused.code, "LXMLA226", "{refused:?}");
    assert!(alignment.station_at_distance(0.0).is_err());
}
