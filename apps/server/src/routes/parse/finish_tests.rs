// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5984: the IFC-authored finish over the REST JSON routes, as a client
//! receives it: `metallic` / `roughness` on each mesh object, absent where
//! unauthored, and an authored `0` kept as `0`.

use super::json_tests::{multipart_body, test_state};
use crate::build_router;
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use serde_json::Value;
use tower::ServiceExt;

/// #957 type-only geometry whose ONLY style is on the type's representation
/// map item: `SpecularColour = 0.75` gives roughness 0.25. Its mesh carries
/// no `geometry_item_id`, so this is the type-level reach, not the item join.
const TYPE_ONLY: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-5984 type-only finish'),'2;1');
FILE_NAME('t.ifc','2026-09-25T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#43=IFCBOILERTYPE('2n5ASfQfT84eP9h$zLLJ4A',$,'Boiler',$,$,$,(#44),$,$,.NOTDEFINED.);
#44=IFCREPRESENTATIONMAP(#45,#46);
#45=IFCAXIS2PLACEMENT3D(#4,$,$);
#46=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#48));
#48=IFCTRIANGULATEDFACESET(#49,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#49=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#50=IFCSTYLEDITEM(#48,(#52),$);
#52=IFCSURFACESTYLE($,.POSITIVE.,(#54));
#54=IFCSURFACESTYLERENDERING(#56,$,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.75),$,.NOTDEFINED.);
#56=IFCCOLOURRGB($,0.6,0.5,0.4);
ENDSEC;
END-ISO-10303-21;
"#;

async fn post(label: &str, uri: &str, content: &[u8]) -> Vec<u8> {
    let state = test_state(label).await;
    let (content_type, body) = multipart_body(content);
    let request = Request::builder()
        .method("POST")
        .uri(uri)
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .unwrap();
    let response = build_router(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec()
}

/// Every mesh object in a JSON parse body or an SSE stream's batch events.
fn mesh_objects(body: &[u8], sse: bool) -> Vec<Value> {
    let text = std::str::from_utf8(body).unwrap();
    let docs: Vec<Value> = if sse {
        text.lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .map(|d| serde_json::from_str(d.trim()).unwrap())
            .collect()
    } else {
        vec![serde_json::from_str(text).unwrap()]
    };
    docs.iter()
        .filter_map(|d| d["meshes"].as_array())
        .flatten()
        .cloned()
        .collect()
}

fn roughness_of(mesh: &Value) -> Option<f64> {
    mesh.get("roughness").and_then(Value::as_f64)
}

#[tokio::test]
async fn json_and_sse_carry_a_type_level_finish() {
    for (label, uri, sse) in [("finish-json", "/api/v1/parse", false), ("finish-sse", "/api/v1/parse/stream", true)] {
        let meshes = mesh_objects(&post(label, uri, TYPE_ONLY.as_bytes()).await, sse);
        let boiler: Vec<&Value> = meshes.iter().filter(|m| m["express_id"] == 43).collect();
        assert_eq!(boiler.len(), 1, "{uri}: the orphan type map renders once");
        let r = roughness_of(boiler[0]).unwrap_or_else(|| panic!("{uri}: no roughness on {}", boiler[0]));
        assert!((r - 0.25).abs() < 1e-6, "{uri}: roughness {r}");
        assert!(boiler[0].get("metallic").is_none(), "{uri}: no metal evidence, so no key");
    }
}

#[tokio::test]
async fn an_unauthored_mesh_keeps_its_old_wire_shape() {
    let plain = TYPE_ONLY.replace("IFCNORMALISEDRATIOMEASURE(0.75)", "$");
    let meshes = mesh_objects(&post("finish-none", "/api/v1/parse", plain.as_bytes()).await, false);
    assert!(!meshes.is_empty());
    for m in &meshes {
        assert!(m.get("metallic").is_none() && m.get("roughness").is_none(), "{m}");
    }
}

/// Acceptance: `AC20-FZK-Haus.ifc` over `POST /api/v1/parse` gives Glas 0
/// (present, not dropped as falsy), 'Kiefer, glänzend' 0.25, 'Kiefer' 0.9.
#[tokio::test]
async fn fzk_haus_finishes_over_the_json_route() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/models/ara3d/AC20-FZK-Haus.ifc");
    let Ok(content) = std::fs::read(&path) else {
        eprintln!("AC20-FZK-Haus.ifc missing — run `pnpm fixtures`. Skipping #5984 fixture test.");
        return;
    };
    let meshes = mesh_objects(&post("finish-fzk", "/api/v1/parse", &content).await, false);
    for (name, expected) in [("Glas", 0.0), ("Kiefer, gl\u{e4}nzend", 0.25), ("Kiefer", 0.9)] {
        let named: Vec<&Value> = meshes.iter().filter(|m| m["material_name"] == name).collect();
        assert!(!named.is_empty(), "no {name:?} meshes");
        for m in named {
            let r = roughness_of(m).unwrap_or_else(|| panic!("{name} mesh {} has no roughness", m["express_id"]));
            assert!((r - expected).abs() < 1e-6, "{name} mesh {}: {r}", m["express_id"]);
            assert!(m.get("metallic").is_none(), "{name}: no metal");
        }
    }
}
