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
