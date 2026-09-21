// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Reproducible native acceptance probe for #5050 LandXML streaming.
//!
//! It intentionally generates representative source rather than depending on
//! an unversioned fixture download.  It is an acceptance harness, not a
//! threshold benchmark: source shape and bounded-credit invariants fail, while
//! timings are reported as evidence for the machine which ran it.

use ifc_lite_landxml::{
    parse_landxml_document, LandXmlDocument, LandXmlLimits, LandXmlMetadataRecord,
    LandXmlMetadataStreamEvent, LandXmlStreamEvent, LandXmlSurface, LandXmlSurfaceComponent,
    LandXmlTinDocument, LandXmlTinStreamSession, MAX_LANDXML_STREAM_DRAIN_BYTES,
    MAX_LANDXML_STREAM_QUEUED_BYTES, MAX_LANDXML_STREAM_QUEUED_EVENTS,
};
use std::{collections::HashSet, error::Error, fmt::Write, time::Instant};

const INPUT_CHUNK_BYTES: usize = 64 * 1024;
const LARGE_TIN_SIDE: usize = 300;
const HIGH_VALENCE_FACES: usize = 20_000;
const MANY_SURFACES: usize = 256;
const OVERLAY_LINES_PER_KIND: usize = 24;
const NON_TERRAIN_COGO_POINTS: usize = 32;

struct Case {
    name: &'static str,
    source: String,
    expected: Shape,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct Shape {
    surfaces: usize,
    points: usize,
    faces: usize,
    boundaries: usize,
    breaklines: usize,
    contours: usize,
}

impl Shape {
    fn from_document(document: &LandXmlTinDocument) -> Self {
        document
            .surfaces
            .iter()
            .fold(Self::default(), |mut shape, surface| {
                shape.surfaces += 1;
                shape.points += surface.points.len();
                shape.faces += surface.faces.len();
                shape.boundaries += surface.boundaries.len();
                shape.breaklines += surface.breaklines.len();
                shape.contours += surface.contours.len();
                shape
            })
    }
}

#[derive(Default)]
struct StreamStats {
    surface_fragments: usize,
    metadata_records: usize,
    delivered_shape: Shape,
    ended_surface_ids: HashSet<String>,
    surface_end_events: usize,
    cogo_point_records: usize,
    metadata_end_events: usize,
    end_surfaces: Option<usize>,
    end_cogo_points: Option<usize>,
    queue_peak_bytes: usize,
    queue_peak_events: usize,
    largest_transport_payload_bytes: usize,
}

fn main() -> Result<(), Box<dyn Error>> {
    println!(
        "#5050 native LandXML acceptance (input chunks: {INPUT_CHUNK_BYTES} bytes; queue cap: {MAX_LANDXML_STREAM_QUEUED_BYTES} bytes)"
    );
    println!(
        "case\tinput\twhole_ms\tstream_ms\twhole_MiB/s\tstream_MiB/s\tsurfaces\tpoints\tfaces\tboundaries\tbreaklines\tcontours\tcogo_points\tqueue_peak\tqueue_events\tretained_surface_or_event_proxy\tretained_nonterrain_proxy\tretained_document_proxy"
    );

    for case in cases() {
        run_case(&case)?;
    }
    Ok(())
}

fn run_case(case: &Case) -> Result<(), Box<dyn Error>> {
    let input_bytes = case.source.len();
    let whole_start = Instant::now();
    let document = parse_landxml_document(case.source.as_bytes())?;
    let whole_elapsed = whole_start.elapsed();
    let actual = Shape::from_document(&document.terrain);
    assert_eq!(actual, case.expected, "{} whole-load shape", case.name);

    let document_proxy_bytes = serde_json::to_vec(&document)?.len();
    let retained_surface_proxy_bytes = largest_surface_proxy(&document.terrain)?;
    let non_terrain_proxy_bytes = non_terrain_proxy(&document)?;

    let stream_start = Instant::now();
    let stream = stream_case(case.source.as_bytes())?;
    let stream_elapsed = stream_start.elapsed();
    assert_eq!(
        stream.end_surfaces,
        Some(case.expected.surfaces),
        "{} stream completion surface count",
        case.name
    );
    assert_eq!(
        stream.end_cogo_points,
        Some(NON_TERRAIN_COGO_POINTS),
        "{} stream completion COGO count",
        case.name
    );
    assert_eq!(
        stream.delivered_shape, case.expected,
        "{} streamed component delivery",
        case.name
    );
    assert_eq!(
        stream.surface_end_events, case.expected.surfaces,
        "{} surface End event count",
        case.name
    );
    assert_eq!(
        stream.ended_surface_ids.len(),
        case.expected.surfaces,
        "{} distinct completed surface IDs",
        case.name
    );
    assert_eq!(
        stream.cogo_point_records, NON_TERRAIN_COGO_POINTS,
        "{} delivered COGO records",
        case.name
    );
    assert_eq!(
        stream.metadata_end_events, 1,
        "{} metadata End event count",
        case.name
    );
    assert!(
        stream.metadata_records > 0,
        "{} completed metadata cursor",
        case.name
    );
    assert!(
        stream.queue_peak_bytes <= MAX_LANDXML_STREAM_QUEUED_BYTES,
        "{} exceeded the credited transport queue",
        case.name
    );
    assert!(
        stream.queue_peak_events <= MAX_LANDXML_STREAM_QUEUED_EVENTS,
        "{} exceeded the credited transport event cap",
        case.name
    );

    println!(
        "{}\t{}\t{:.3}\t{:.3}\t{:.2}\t{:.2}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
        case.name,
        bytes(input_bytes),
        millis(whole_elapsed),
        millis(stream_elapsed),
        mebibytes_per_second(input_bytes, whole_elapsed),
        mebibytes_per_second(input_bytes, stream_elapsed),
        actual.surfaces,
        actual.points,
        actual.faces,
        actual.boundaries,
        actual.breaklines,
        actual.contours,
        NON_TERRAIN_COGO_POINTS,
        bytes(stream.queue_peak_bytes),
        stream.queue_peak_events,
        bytes(retained_surface_proxy_bytes.max(stream.largest_transport_payload_bytes)),
        bytes(non_terrain_proxy_bytes),
        bytes(document_proxy_bytes),
    );
    Ok(())
}

fn stream_case(source: &[u8]) -> Result<StreamStats, Box<dyn Error>> {
    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default())?;
    let mut stats = StreamStats::default();
    for chunk in source.chunks(INPUT_CHUNK_BYTES) {
        drain_until_idle(&mut session, &mut stats)?;
        session.advance(chunk)?;
        sample_queue(&session, &mut stats);
        drain_until_idle(&mut session, &mut stats)?;
    }
    session.finish_cursor()?;
    sample_queue(&session, &mut stats);
    drain_until_idle(&mut session, &mut stats)?;
    Ok(stats)
}

fn drain_until_idle(
    session: &mut LandXmlTinStreamSession,
    stats: &mut StreamStats,
) -> Result<(), Box<dyn Error>> {
    while session.output_pending() {
        sample_queue(session, stats);
        let events = session.drain(MAX_LANDXML_STREAM_DRAIN_BYTES)?;
        assert!(!events.is_empty(), "credited stream made no progress");
        for event in events {
            observe_event(event, stats);
        }
    }
    Ok(())
}

fn sample_queue(session: &LandXmlTinStreamSession, stats: &mut StreamStats) {
    stats.queue_peak_bytes = stats.queue_peak_bytes.max(session.queued_bytes());
    stats.queue_peak_events = stats.queue_peak_events.max(session.queued_events());
}

fn observe_event(event: LandXmlStreamEvent, stats: &mut StreamStats) {
    match event {
        LandXmlStreamEvent::Surface(fragment) => {
            stats.surface_fragments += 1;
            stats.largest_transport_payload_bytes = stats
                .largest_transport_payload_bytes
                .max(fragment.payload_utf8.len());
            if !fragment.continued {
                match fragment.component {
                    LandXmlSurfaceComponent::Start
                    | LandXmlSurfaceComponent::CanonicalVertices
                    | LandXmlSurfaceComponent::SourceDataPoints => {}
                    LandXmlSurfaceComponent::Points => stats.delivered_shape.points += 1,
                    LandXmlSurfaceComponent::Faces => stats.delivered_shape.faces += 1,
                    LandXmlSurfaceComponent::Boundaries => {
                        stats.delivered_shape.boundaries += 1;
                    }
                    LandXmlSurfaceComponent::Breaklines => {
                        stats.delivered_shape.breaklines += 1;
                    }
                    LandXmlSurfaceComponent::Contours => stats.delivered_shape.contours += 1,
                    LandXmlSurfaceComponent::End => {
                        stats.delivered_shape.surfaces += 1;
                        stats.surface_end_events += 1;
                        stats.ended_surface_ids.insert(fragment.source_id);
                    }
                }
            }
        }
        LandXmlStreamEvent::Metadata(event) => match *event {
            LandXmlMetadataStreamEvent::End(end) => {
                stats.metadata_end_events += 1;
                stats.end_surfaces = Some(end.surfaces_drained);
                stats.end_cogo_points = Some(end.plan_cogo_points);
            }
            LandXmlMetadataStreamEvent::Record(record) => {
                stats.metadata_records += 1;
                if matches!(record.as_ref(), LandXmlMetadataRecord::PlanCogoPoint(_)) {
                    stats.cogo_point_records += 1;
                }
            }
            LandXmlMetadataStreamEvent::RecordFragment(fragment) => {
                stats.metadata_records += 1;
                if fragment.record == "plan_cogo_point" && !fragment.continued {
                    stats.cogo_point_records += 1;
                }
            }
            LandXmlMetadataStreamEvent::Header(_) => {}
        },
        LandXmlStreamEvent::Header(_) => {}
    }
}

fn largest_surface_proxy(document: &LandXmlTinDocument) -> Result<usize, serde_json::Error> {
    document.surfaces.iter().try_fold(0, |largest, surface| {
        surface_proxy_bytes(surface).map(|bytes| largest.max(bytes))
    })
}

fn non_terrain_proxy(document: &LandXmlDocument) -> Result<usize, serde_json::Error> {
    serde_json::to_vec(&document.plan).map(|serialized| serialized.len())
}

fn surface_proxy_bytes(surface: &LandXmlSurface) -> Result<usize, serde_json::Error> {
    serde_json::to_vec(surface).map(|serialized| serialized.len())
}

fn cases() -> [Case; 4] {
    [
        large_tin_case(),
        high_valence_case(),
        many_surfaces_case(),
        overlays_case(),
    ]
}

fn large_tin_case() -> Case {
    let mut points = String::new();
    let mut faces = String::new();
    for row in 0..LARGE_TIN_SIDE {
        for column in 0..LARGE_TIN_SIDE {
            let id = row * LARGE_TIN_SIDE + column + 1;
            write!(points, "<P id=\"{id}\">{row} {column} 0</P>").expect("string write");
        }
    }
    for row in 0..LARGE_TIN_SIDE - 1 {
        for column in 0..LARGE_TIN_SIDE - 1 {
            let lower_left = row * LARGE_TIN_SIDE + column + 1;
            let lower_right = lower_left + 1;
            let upper_left = lower_left + LARGE_TIN_SIDE;
            let upper_right = upper_left + 1;
            write!(faces, "<F>{lower_left} {lower_right} {upper_left}</F>").expect("string write");
            write!(faces, "<F>{lower_right} {upper_right} {upper_left}</F>").expect("string write");
        }
    }
    Case {
        name: "large_tin",
        source: landxml(&format!(
            "<Surfaces><Surface name=\"large\"><Definition surfType=\"TIN\"><Pnts>{points}</Pnts><Faces>{faces}</Faces></Definition></Surface></Surfaces>"
        )),
        expected: Shape {
            surfaces: 1,
            points: LARGE_TIN_SIDE * LARGE_TIN_SIDE,
            faces: 2 * (LARGE_TIN_SIDE - 1) * (LARGE_TIN_SIDE - 1),
            ..Shape::default()
        },
    }
}

fn high_valence_case() -> Case {
    let mut points = String::from("<P id=\"1\">0 0 0</P>");
    let mut faces = String::new();
    for ordinal in 0..HIGH_VALENCE_FACES {
        let id = ordinal + 2;
        write!(points, "<P id=\"{id}\">{ordinal} 1 0</P>").expect("string write");
    }
    for ordinal in 0..HIGH_VALENCE_FACES {
        let current = ordinal + 2;
        let next = if ordinal + 1 == HIGH_VALENCE_FACES {
            2
        } else {
            current + 1
        };
        write!(faces, "<F>1 {current} {next}</F>").expect("string write");
    }
    Case {
        name: "high_valence_refs",
        source: landxml(&format!(
            "<Surfaces><Surface name=\"fan\"><Definition surfType=\"TIN\"><Pnts>{points}</Pnts><Faces>{faces}</Faces></Definition></Surface></Surfaces>"
        )),
        expected: Shape {
            surfaces: 1,
            points: HIGH_VALENCE_FACES + 1,
            faces: HIGH_VALENCE_FACES,
            ..Shape::default()
        },
    }
}

fn many_surfaces_case() -> Case {
    let mut surfaces = String::new();
    for ordinal in 0..MANY_SURFACES {
        write!(
            surfaces,
            "<Surface name=\"tile-{ordinal}\"><Definition surfType=\"TIN\"><Pnts><P id=\"1\">0 0 0</P><P id=\"2\">0 1 0</P><P id=\"3\">1 0 0</P><P id=\"4\">1 1 0</P></Pnts><Faces><F>1 2 3</F><F>2 4 3</F></Faces></Definition></Surface>"
        )
        .expect("string write");
    }
    Case {
        name: "many_surfaces",
        source: landxml(&format!("<Surfaces>{surfaces}</Surfaces>")),
        expected: Shape {
            surfaces: MANY_SURFACES,
            points: MANY_SURFACES * 4,
            faces: MANY_SURFACES * 2,
            ..Shape::default()
        },
    }
}

fn overlays_case() -> Case {
    let boundary = "<Boundary bndType=\"outer\"><PntList3D>0 0 0 0 100 0 100 100 0 100 0 0 0 0 0</PntList3D></Boundary>";
    let mut breaklines = String::new();
    let mut contours = String::new();
    for ordinal in 0..OVERLAY_LINES_PER_KIND {
        write!(breaklines, "<Breakline brkType=\"standard\"><PntList3D>0 {ordinal} 0 100 {ordinal} 0</PntList3D></Breakline>").expect("string write");
        write!(contours, "<Contour contType=\"minor\"><PntList3D>0 {ordinal} {ordinal} 100 {ordinal} {ordinal}</PntList3D></Contour>").expect("string write");
    }
    Case {
        name: "boundary_breakline_contour",
        source: landxml(&format!(
            "<Surfaces><Surface name=\"overlays\"><Definition surfType=\"TIN\"><Pnts><P id=\"1\">0 0 0</P><P id=\"2\">0 100 0</P><P id=\"3\">100 0 0</P><P id=\"4\">100 100 0</P></Pnts><Faces><F>1 2 3</F><F>2 4 3</F></Faces></Definition><SourceData><Boundaries>{boundary}</Boundaries><Breaklines>{breaklines}</Breaklines><Contours>{contours}</Contours></SourceData></Surface></Surfaces>"
        )),
        expected: Shape {
            surfaces: 1,
            points: 4,
            faces: 2,
            boundaries: 1,
            breaklines: OVERLAY_LINES_PER_KIND,
            contours: OVERLAY_LINES_PER_KIND,
        },
    }
}

fn landxml(body: &str) -> String {
    let cogo_points = (0..NON_TERRAIN_COGO_POINTS)
        .map(|ordinal| format!("<CgPoint name=\"control-{ordinal}\">{ordinal} 0 0</CgPoint>"))
        .collect::<String>();
    format!(
        "<LandXML xmlns=\"http://www.landxml.org/schema/LandXML-1.2\" version=\"1.2\"><Units><Metric linearUnit=\"meter\"/></Units>{body}<CgPoints>{cogo_points}</CgPoints></LandXML>"
    )
}

fn millis(duration: std::time::Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn mebibytes_per_second(bytes: usize, duration: std::time::Duration) -> f64 {
    (bytes as f64 / (1024.0 * 1024.0)) / duration.as_secs_f64()
}

fn bytes(value: usize) -> String {
    const KIB: usize = 1024;
    const MIB: usize = 1024 * 1024;
    if value >= MIB {
        format!("{:.2}MiB", value as f64 / MIB as f64)
    } else if value >= KIB {
        format!("{:.2}KiB", value as f64 / KIB as f64)
    } else {
        format!("{value}B")
    }
}
