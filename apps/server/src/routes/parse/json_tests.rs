// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Handler-level tests for `POST /api/v1/parse/metadata` (`parse_metadata`) —
//! previously exercised only via status-code assertions elsewhere
//! (`parity_tests.rs`'s admission tests); this file pins the actual counted
//! response values.

use crate::config::Config;
use crate::services::cache::DiskCache;
use crate::{build_router, AppState};
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use serde_json::Value;
use std::sync::Arc;
use tower::ServiceExt;

const BOUNDARY: &str = "ifclite-r31-metadata-boundary";

/// 16 STEP entities total: #1..#7, #40, #300..#307 (8). Exactly ONE
/// (`IFCWALL` at #307) is a geometry-bearing `IfcProduct` — the rest are
/// project/context/unit/placement scaffolding (`IfcProject`,
/// `IfcLocalPlacement`, etc.) that carries no representation of its own.
const FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('r31 metadata fixture'),'2;1');
FILE_NAME('meta.ifc','2026-06-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6,#7));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#40=IFCLOCALPLACEMENT($,#5);
#300=IFCCARTESIANPOINT((0.,0.));
#301=IFCAXIS2PLACEMENT2D(#300,$);
#302=IFCRECTANGLEPROFILEDEF(.AREA.,$,#301,1.0,0.2);
#303=IFCDIRECTION((0.,0.,1.));
#304=IFCEXTRUDEDAREASOLID(#302,#5,#303,3.0);
#305=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#304));
#306=IFCPRODUCTDEFINITIONSHAPE($,$,(#305));
#307=IFCWALL('Wall00000000000000001',$,'W1',$,$,#40,#306,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

fn multipart_body(content: &[u8]) -> (String, Vec<u8>) {
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"meta.ifc\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(content);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={BOUNDARY}"), body)
}

async fn test_state(label: &str) -> AppState {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-r31-metadata-{}-{}",
        std::process::id(),
        label
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let cache = Arc::new(DiskCache::new(dir.to_str().unwrap()).await);
    AppState {
        cache,
        config: Arc::new(Config::from_env()),
        admission: Arc::new(crate::admission::Admission::new(
            crate::admission::AdmissionCfg {
                max_concurrent_parses: 4,
                mem_budget_bytes: 0,
                queue_depth: 8,
                queue_timeout: std::time::Duration::from_millis(100),
                shed_pct: 85,
            },
        )),
    }
}

#[tokio::test]
async fn parse_metadata_counts_entities_and_geometry_separately() {
    let state = test_state("counts").await;
    let (content_type, body) = multipart_body(FIXTURE.as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/parse/metadata")
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .unwrap();
    let response = build_router(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(json["entity_count"].as_u64().unwrap(), 16);
    assert_eq!(json["geometry_count"].as_u64().unwrap(), 1);
    assert_eq!(json["schema_version"].as_str().unwrap(), "IFC4");
    assert_eq!(json["file_size"].as_u64().unwrap(), FIXTURE.len() as u64);
}
/// The intact fixture with one extra record appended, whose instance name is
/// `u32::MAX + 2` and so cannot be represented in the `u32` every express-id
/// column in this workspace uses. DERIVED from `FIXTURE` rather than copied,
/// so the two cannot drift into differing by something other than the record
/// under test — a second copy is a second thing to keep in sync, and a
/// divergence there would move the counts this test reads.
fn fixture_with_oversized_id() -> String {
    let derived = FIXTURE.replace(END_OF_DATA, &format!("{OVERSIZED_RECORD}\n{END_OF_DATA}"));
    assert!(
        derived.contains(OVERSIZED_RECORD),
        "the splice must actually fire; a no-op replace would hand back the intact fixture"
    );
    derived
}

/// The intact fixture with `#302`'s first string literal left unterminated,
/// so `find_entity_end` runs off the end of the buffer and the scan stops
/// there (#3695) — every record after it is silently absent from the count.
/// Derived for the same reason as above.
fn fixture_with_unterminated_string() -> String {
    let derived = FIXTURE.replace(INTACT_302, BROKEN_302);
    assert!(
        derived.contains(BROKEN_302) && !derived.contains(INTACT_302),
        "the corruption must actually fire; a no-op replace would hand back the intact fixture"
    );
    derived
}

/// The two lines that close the fixture's DATA section, i.e. where a record
/// gets appended.
const END_OF_DATA: &str = "ENDSEC;\nEND-ISO-10303-21;";
/// `#4294967297` is `u32::MAX + 2`: a regression that wraps yields `1` and
/// collides with a real entity rather than merely erroring.
const OVERSIZED_RECORD: &str = "#4294967297=IFCWALL('Wall00000000000000002',$,'W2',$,$,#40,#306,$,$);";
const INTACT_302: &str = "#302=IFCRECTANGLEPROFILEDEF(.AREA.,$,#301,1.0,0.2);";
const BROKEN_302: &str = "#302=IFCRECTANGLEPROFILEDEF(.AREA.,'unterminated,#301,1.0,0.2);";

/// How many records `FIXTURE` declares before the one that
/// `fixture_with_unterminated_string` breaks.
///
/// Counted off the fixture TEXT (one record per line), not off a parse, so
/// the expected value does not come from the scanner whose behaviour is
/// under test.
fn records_before_302() -> u64 {
    FIXTURE
        .lines()
        .take_while(|line| !line.starts_with("#302="))
        .filter(|line| line.starts_with('#'))
        .count() as u64
}

/// POST `content` to `/api/v1/parse/metadata` and return the decoded body.
async fn metadata_json(label: &str, content: &str) -> Value {
    let state = test_state(label).await;
    let (content_type, body) = multipart_body(content.as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/parse/metadata")
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .unwrap();
    let response = build_router(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

/// `entity_count` from a metadata response.
fn entity_count(json: &Value) -> u64 {
    json["entity_count"].as_u64().expect("entity_count must be a number")
}

/// #3791: the handler walks its own `EntityScanner` and returned a 200 whose
/// `entity_count` was computed over the bytes before a refusal — with nothing
/// in the response distinguishing that from a whole file. Asserted through the
/// HTTP response, not the scanner, because the response is what a client sees.
#[tokio::test]
async fn parse_metadata_reports_a_refused_oversized_id() {
    let baseline = entity_count(&metadata_json("oversized-baseline", FIXTURE).await);
    let json = metadata_json("oversized", &fixture_with_oversized_id()).await;

    // The appended record really is gone: the same count as the fixture it
    // was derived from, measured rather than written down, so the assertion
    // cannot go stale when someone edits FIXTURE.
    assert_eq!(
        entity_count(&json),
        baseline,
        "the extra record is refused, so the count is indistinguishable from the intact file"
    );
    assert_eq!(json["oversized_id_count"].as_u64().unwrap(), 1);
    assert!(!json["malformed_record_found"].as_bool().unwrap());
}

/// The other stop, same surface: an unterminated string ends the scan, so the
/// count covers only the records before it.
#[tokio::test]
async fn parse_metadata_reports_a_malformed_record_stop() {
    let baseline = entity_count(&metadata_json("malformed-baseline", FIXTURE).await);
    let json = metadata_json("malformed", &fixture_with_unterminated_string()).await;

    let counted = entity_count(&json);
    assert!(
        counted < baseline,
        "the scan must come back short of the intact fixture's {baseline}, got {counted}"
    );
    assert_eq!(
        counted,
        records_before_302(),
        "the scan stops at #302, so exactly the records before it are counted"
    );
    assert!(json["malformed_record_found"].as_bool().unwrap());
    assert_eq!(json["oversized_id_count"].as_u64().unwrap(), 0);
}

/// The other direction: an intact file must report neither, or a client would
/// learn to ignore both fields.
#[tokio::test]
async fn parse_metadata_reports_nothing_on_an_intact_file() {
    let json = metadata_json("intact", FIXTURE).await;

    assert_eq!(json["oversized_id_count"].as_u64().unwrap(), 0);
    assert!(!json["malformed_record_found"].as_bool().unwrap());
}
