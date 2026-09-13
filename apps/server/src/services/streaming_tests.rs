// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `streaming.rs` (ratchet-exempt sibling file).

use super::*;

/// No `FILE_SCHEMA` declaration at all must default to IFC2X3 rather than
/// panicking or misreporting a newer schema.
#[test]
fn detect_schema_version_defaults_to_ifc2x3_when_undeclared() {
    let content = b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
    assert_eq!(detect_schema_version(content), "IFC2X3");
}

#[test]
fn detect_schema_version_detects_ifc4() {
    let content =
        b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
    assert_eq!(detect_schema_version(content), "IFC4");
}

/// `"IFC4X3"` contains `"IFC4"` as a literal substring, so a checker that
/// tests the IFC4 pattern before the IFC4X3 pattern (or that only ever tests
/// IFC4) would misclassify every IFC4X3 file as IFC4. The IFC4X3 branch must
/// be tried FIRST (or matched precisely) so this doesn't happen.
#[test]
fn detect_schema_version_detects_ifc4x3_not_ifc4() {
    let content = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4X3'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
    assert_eq!(detect_schema_version(content), "IFC4X3");
}

/// Schema-like text appearing in the DATA section (after the header's
/// `ENDSEC;`) must NOT influence the detected schema — only the HEADER's
/// `FILE_SCHEMA` declaration is authoritative. The HEADER here declares no
/// `FILE_SCHEMA` at all (so the correct answer is the IFC2X3 default); a scan
/// that doesn't stop at the header's `ENDSEC;` would find the `FILE_SCHEMA`-
/// looking text stored as IFC data and misreport IFC4X3.
#[test]
fn detect_schema_version_ignores_schema_like_text_in_data_section() {
    let content = b"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nENDSEC;\nDATA;\n#1=IFCTEXT('mentions FILE_SCHEMA((IFC4X3)) in a comment field');\nENDSEC;\nEND-ISO-10303-21;";
    assert_eq!(detect_schema_version(content), "IFC2X3");
}

/// An IFC4 model of `walls` extruded-solid walls, each its own geometry job,
/// so `initial_batch_size = 1` turns every wall into one `Batch` frame.
fn walls_fixture(walls: usize) -> String {
    let mut ifc = String::from(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('streaming backpressure fixture'),'2;1');
FILE_NAME('walls.ifc','2026-09-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6,#7));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#8=IFCCARTESIANPOINT((0.,0.));
#9=IFCAXIS2PLACEMENT2D(#8,$);
#10=IFCRECTANGLEPROFILEDEF(.AREA.,$,#9,1.0,0.2);
#11=IFCDIRECTION((0.,0.,1.));
"#,
    );
    for i in 0..walls {
        let b = 100 + i * 10;
        ifc.push_str(&format!(
            "#{p}=IFCCARTESIANPOINT(({x}.,0.,0.));\n\
             #{a}=IFCAXIS2PLACEMENT3D(#{p},$,$);\n\
             #{l}=IFCLOCALPLACEMENT($,#{a});\n\
             #{s}=IFCEXTRUDEDAREASOLID(#10,#{a},#11,3.0);\n\
             #{r}=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#{s}));\n\
             #{d}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{r}));\n\
             #{w}=IFCWALL('Wall{i:017}',$,'W{i}',$,$,#{l},#{d},$,$);\n",
            p = b,
            x = i * 5,
            a = b + 1,
            l = b + 2,
            s = b + 3,
            r = b + 4,
            d = b + 5,
            w = b + 6,
        ));
    }
    ifc.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    ifc
}

/// A client that stops reading must park the producer, not have the model
/// buffered for it: the channel between the blocking parse and the response
/// stream is bounded and the producer waits for capacity.
///
/// What this observes: `ProcessingStats::total_time_ms` is the pipeline's own
/// wall clock, running from the first byte to the last batch callback. With
/// the bound in place the callback is parked in `blocking_send` for as long
/// as the consumer sleeps, so that clock has to run at least as long as the
/// stall. Against an unbounded channel (the defect) every frame is queued the
/// moment it is produced, the pipeline finishes a ten-wall model in
/// milliseconds, and the clock reads far under the stall. The threshold is
/// half the stall, so the assertion is one-sided on purpose: a loaded machine
/// can only make a parked producer's clock read longer, never shorter.
///
/// The drain afterwards proves the other half of the contract: nothing was
/// dropped while the producer waited, every wall's batch and the `Complete`
/// frame still arrive, inside a timeout so a producer that never resumes
/// fails instead of hanging.
///
/// Regression for #4634.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_consumer_that_stops_reading_parks_the_producer_instead_of_buffering_the_model() {
    use futures::StreamExt;
    use std::time::Duration;
    use tokio::time::timeout;

    const WALLS: usize = 10;
    const STALL: Duration = Duration::from_secs(1);
    const DRAIN_BUDGET: Duration = Duration::from_secs(30);

    let mut stream = process_streaming(
        bytes::Bytes::from(walls_fixture(WALLS)),
        1,
        1,
        OpeningFilterMode::Default,
        TessellationQuality::default(),
        None,
    );

    let first = timeout(DRAIN_BUDGET, stream.next())
        .await
        .expect("the first frame must arrive")
        .expect("the stream must not end before its first frame");
    assert!(matches!(first, StreamEvent::Start { .. }), "got {first:?}");

    // The client stops reading here. `stream` stays alive, exactly as a
    // response body does until the socket goes away: a stall, not a
    // disconnect, so the producer must wait rather than be cancelled.
    tokio::time::sleep(STALL).await;

    let rest: Vec<StreamEvent> = timeout(DRAIN_BUDGET, stream.collect())
        .await
        .expect("a parked producer must resume once the client reads again");

    // Nothing may be dropped while the producer waits, and the fixture must
    // produce more frames than the bound holds or the producer never had to.
    let batches = rest
        .iter()
        .filter(|event| matches!(event, StreamEvent::Batch { .. }))
        .count();
    assert_eq!(batches, WALLS, "every wall's batch must arrive");
    assert!(
        rest.len() > EVENT_BUFFER_EVENTS,
        "fixture too small to overflow the bound of {EVENT_BUFFER_EVENTS}: {} frames",
        rest.len()
    );

    let Some(StreamEvent::Complete { stats, .. }) = rest.last() else {
        panic!("the stream must end in Complete, got {:?}", rest.last());
    };
    assert_eq!(stats.total_meshes, WALLS);
    let floor_ms = (STALL.as_millis() / 2) as u64;
    assert!(
        stats.total_time_ms >= floor_ms,
        "the pipeline finished in {}ms while the client read nothing for {STALL:?}: \
         the producer queued the model instead of waiting for capacity",
        stats.total_time_ms
    );
}
