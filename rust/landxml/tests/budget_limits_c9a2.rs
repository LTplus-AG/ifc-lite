// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C9a-2 (#7784): every cap that moved onto `xml::Budget` still refuses with
//! its own code and text. The refactor is only an R if no message moves, and
//! until now almost none of these texts were pinned. Each row names the cap,
//! a document that spends it, the limits that exhaust it and the exact text.

use ifc_lite_landxml::{
    alignment::{parse_landxml_alignments_optional_with_cancel, LandXmlAlignmentLimits},
    parse_landxml_pipe_networks_with_cancel, parse_landxml_plan_with_cancel,
    parse_landxml_tin_with_cancel, LandXmlDiagnosticCode, LandXmlLimits, LandXmlPlanLimits,
    LandXmlTinStreamSession,
};

const NS: &str = "http://www.landxml.org/schema/LandXML-1.2";

fn doc(body: &str) -> String {
    format!(r#"<LandXML xmlns="{NS}" version="1.2"><Units><Metric linearUnit="meter"/></Units>{body}</LandXML>"#)
}

const TIN: &str = r#"<Surfaces><Surface name="s"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces>"#;

const PROFILE: &str = r#"<Alignments><Alignment name="A" length="300" staStart="100"><CoordGeom/><Profile><ProfAlign name="design"><PVI>100 20</PVI><ParaCurve length="40">140 21</ParaCurve><CircCurve length="30" radius="250">180 23</CircCurve></ProfAlign></Profile><CrossSects><CrossSect sta="140"><CrossSectSurf name="existing"><PntList2D>-5 19 0 20 5 19</PntList2D></CrossSectSurf></CrossSect></CrossSects></Alignment></Alignments>"#;

const ALIGNMENT: &str = r#"<Alignments><Alignment name="a" length="10" staStart="0"><CoordGeom><Line><Start>0 0</Start><End>1 0</End></Line></CoordGeom><AlignPIs><AlignPI>0 0</AlignPI></AlignPIs><StaEquation staInternal="1" staBack="1" staAhead="2" staIncrement="increasing"/><Cant name="c" gauge="1"><CantStation station="0" appliedCant="1" curvature="ccw"/><SpeedStation station="1" speed="1"/></Cant><Superelevation staStart="0" staEnd="1"><FullSuperelev>0.06</FullSuperelev></Superelevation></Alignment></Alignments>"#;

const PLAN: &str = r#"<Parcels><Parcel name="p" area="1"><CoordGeom><Line><Start>0 0</Start><End>1 0</End></Line></CoordGeom></Parcel></Parcels>"#;

const PIPES: &str = r#"<PipeNetworks><PipeNetwork name="n" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/><Invert refPipe="P" flowDir="out" elev="1"/><StructFlow lossIn="0.1"/></Struct><Struct name="B"><Center>0 1 0</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="P" refStart="A" refEnd="B"><CircPipe diameter="1"/><PipeFlow flowIn="1"/></Pipe></Pipes></PipeNetwork></PipeNetworks>"#;

#[derive(Clone, Copy, Debug)]
enum Reader {
    Tin,
    Plan,
    Alignments,
    Pipes,
    Stream,
}

struct Row {
    cap: &'static str,
    reader: Reader,
    xml: String,
    limits: LandXmlLimits,
    plan: Option<LandXmlPlanLimits>,
    alignment: Option<LandXmlAlignmentLimits>,
    message: &'static str,
}

fn row(cap: &'static str, reader: Reader, xml: String, limits: LandXmlLimits, message: &'static str) -> Row {
    Row { cap, reader, xml, limits, plan: None, alignment: None, message }
}

fn refusal(row: &Row) -> Option<(LandXmlDiagnosticCode, String)> {
    let bytes = row.xml.as_bytes();
    let error = match row.reader {
        Reader::Tin => parse_landxml_tin_with_cancel(bytes, &row.limits, None).err(),
        Reader::Plan => {
            let limits = row.plan.clone().unwrap_or(LandXmlPlanLimits { xml: row.limits.clone(), ..Default::default() });
            parse_landxml_plan_with_cancel(bytes, &limits, None).err()
        }
        Reader::Alignments => {
            let limits = row.alignment.clone().unwrap_or(LandXmlAlignmentLimits { xml: row.limits.clone(), ..Default::default() });
            parse_landxml_alignments_optional_with_cancel(bytes, &limits, None).err()
        }
        Reader::Pipes => parse_landxml_pipe_networks_with_cancel(bytes, &row.limits, None).err(),
        Reader::Stream => (|| {
            let mut session = LandXmlTinStreamSession::new(row.limits.clone())?;
            session.advance(bytes)?;
            session.finish().map(|_| ())
        })()
        .err(),
    };
    error.map(|error| (error.code, error.message))
}

fn limits() -> LandXmlLimits {
    LandXmlLimits::default()
}

#[test]
fn every_budget_refuses_with_its_own_code_and_text() {
    let l = limits;
    let mut plan_geometry = row("plan geometry", Reader::Plan, doc(PLAN), l(), "CoordGeom primitive limit exceeded");
    plan_geometry.plan = Some(LandXmlPlanLimits { max_geometry: 0, ..Default::default() });
    let mut segments = row("alignment segments", Reader::Alignments, doc(ALIGNMENT), l(), "alignment segment limit exceeded");
    segments.alignment = Some(LandXmlAlignmentLimits { max_alignment_segments: 0, ..Default::default() });
    let mut equations = row("station equations", Reader::Alignments, doc(ALIGNMENT), l(), "station equation limit exceeded");
    equations.alignment = Some(LandXmlAlignmentLimits { max_station_equations: 0, ..Default::default() });
    let mut cant = row("cant stations", Reader::Alignments, doc(ALIGNMENT), l(), "CantStation limit exceeded");
    cant.alignment = Some(LandXmlAlignmentLimits { max_cant_stations: 0, ..Default::default() });
    let mut speed = row("speed stations", Reader::Alignments, doc(ALIGNMENT), l(), "CantStation and SpeedStation limit exceeded");
    speed.alignment = Some(LandXmlAlignmentLimits { max_cant_stations: 1, ..Default::default() });
    let mut events = row("superelevation events", Reader::Alignments, doc(ALIGNMENT), l(), "superelevation event limit exceeded");
    events.alignment = Some(LandXmlAlignmentLimits { max_superelevation_events: 0, ..Default::default() });
    let mut alignments = row("alignments", Reader::Alignments, doc(ALIGNMENT), l(), "alignment limit exceeded");
    alignments.alignment = Some(LandXmlAlignmentLimits { max_alignments: 0, ..Default::default() });
    let rows = vec![
        row("work", Reader::Tin, doc(TIN), LandXmlLimits { max_work: 10, ..l() }, "work limit exceeded"),
        row("work (plan)", Reader::Plan, doc(TIN), LandXmlLimits { max_work: 10, ..l() }, "work limit exceeded"),
        row("work (alignments)", Reader::Alignments, doc(ALIGNMENT), LandXmlLimits { max_work: 10, ..l() }, "work limit exceeded"),
        row("work (pipes)", Reader::Pipes, doc(PIPES), LandXmlLimits { max_work: 10, ..l() }, "work limit exceeded"),
        row("character references", Reader::Tin, doc("<Other a=\"&#46;\">&#46;</Other>"), LandXmlLimits { max_character_references: 1, ..l() }, "character reference limit exceeded"),
        row("character references (plan)", Reader::Plan, doc("<Other a=\"&#46;\">&#46;</Other>"), LandXmlLimits { max_character_references: 1, ..l() }, "character reference limit exceeded"),
        row("character references (alignments)", Reader::Alignments, doc("<Other a=\"&#46;\">&#46;</Other>"), LandXmlLimits { max_character_references: 1, ..l() }, "character reference limit exceeded"),
        row("character references (pipes)", Reader::Pipes, doc("<Other a=\"&#46;\">&#46;</Other>"), LandXmlLimits { max_character_references: 1, ..l() }, "character reference limit exceeded"),
        row("references", Reader::Tin, doc(TIN), LandXmlLimits { max_references: 2, ..l() }, "reference limit exceeded"),
        row("references (plan)", Reader::Plan, doc("<Other pntRef=\"a\"/>"), LandXmlLimits { max_references: 0, ..l() }, "reference limit exceeded"),
        row("surfaces", Reader::Tin, doc(TIN), LandXmlLimits { max_surfaces: 0, ..l() }, "surface limit exceeded"),
        row("points", Reader::Tin, doc(TIN), LandXmlLimits { max_points: 2, ..l() }, "point limit exceeded"),
        row("faces", Reader::Tin, doc(TIN), LandXmlLimits { max_faces: 0, ..l() }, "face limit exceeded"),
        row("retained source path", Reader::Tin, doc(r#"<ext:Foo xmlns:ext="urn:x"/>"#), LandXmlLimits { max_source_path_bytes: 1, ..l() }, "retained source path limit exceeded"),
        row("capability diagnostics", Reader::Tin, doc("").replace("version=\"1.2\"", "version=\"1.1\""), LandXmlLimits { max_capability_diagnostics: 0, ..l() }, "capability diagnostic limit exceeded"),
        row("profile points", Reader::Tin, doc(PROFILE), LandXmlLimits { max_profile_points: 1, ..l() }, "profile point limit exceeded"),
        row("vertical curves", Reader::Tin, doc(PROFILE), LandXmlLimits { max_vertical_curves: 0, ..l() }, "vertical curve limit exceeded"),
        row("cross-section points", Reader::Tin, doc(PROFILE), LandXmlLimits { max_cross_section_points: 1, ..l() }, "cross-section point limit exceeded"),
        plan_geometry,
        segments,
        equations,
        cant,
        speed,
        events,
        alignments,
        row("pipe networks", Reader::Pipes, doc(PIPES), LandXmlLimits { max_pipe_networks: 0, ..l() }, "pipe network limit exceeded"),
        row("pipe structures", Reader::Pipes, doc(PIPES), LandXmlLimits { max_pipe_structures: 0, ..l() }, "pipe structure limit exceeded"),
        row("pipes", Reader::Pipes, doc(PIPES), LandXmlLimits { max_pipes: 0, ..l() }, "pipe limit exceeded"),
        row("pipe centres", Reader::Pipes, doc(PIPES), LandXmlLimits { max_points: 0, ..l() }, "pipe Center point limit exceeded"),
        row("pipe inverts", Reader::Pipes, doc(PIPES), LandXmlLimits { max_pipe_inverts: 0, ..l() }, "pipe invert limit exceeded"),
        row("pipe flows", Reader::Pipes, doc(PIPES), LandXmlLimits { max_pipe_flows: 0, ..l() }, "pipe flow limit exceeded"),
        row("stream: raw input", Reader::Stream, doc(TIN), LandXmlLimits { max_bytes: 10, ..l() }, "input exceeds byte limit"),
    ];
    let mut wrong = Vec::new();
    for row in &rows {
        let expected_code = if row.cap == "stream: raw input" { LandXmlDiagnosticCode::InputTooLarge } else { LandXmlDiagnosticCode::LimitExceeded };
        match refusal(row) {
            Some((code, message)) if code == expected_code && message == row.message => {}
            other => wrong.push(format!("{} ({:?}): expected {expected_code:?} {:?}, got {other:?}", row.cap, row.reader, row.message)),
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
