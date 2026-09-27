// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `POST /api/v1/parse/parquet-stream?parquet_layout=shared-shapes&stream_shapes=cross-batch`
//! (issue #5407), driven through the real route on a real IFC.
//!
//! The fixture is built so that sharing can ONLY happen across batches: the
//! route is configured to emit two meshes per batch, and every occurrence of
//! the one mapped shape sits at its own yaw under a yawed, translated site. A
//! rotated occurrence is not bit-identical to anything, so the content hash
//! cannot share it; the rotation-aware collator can, but only against a
//! template an EARLIER batch emitted, and only in the frame the site bakes
//! vertices into. Each assertion below fails if one of those three pieces is
//! removed: the retained template, the published basis, the back-reference.
//!
//! Ground truth throughout is the batch-local stream of the same file, which
//! shares nothing across batches and has shipped since #3888: every mesh must
//! reconstruct to the same world vertices through either stream.

use super::*;
use crate::services::ParquetLayout;
use arrow::array::{Array, Float32Array, Float64Array, RecordBatch, UInt32Array};
use base64::{engine::general_purpose::STANDARD, Engine};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

const SHARED: &str = "?parquet_layout=shared-shapes";
const CROSS_BATCH: &str = "?parquet_layout=shared-shapes&stream_shapes=cross-batch";

/// `n` `IfcBuildingElementProxy` occurrences of ONE `IfcRepresentationMap` (an
/// L-shaped extrusion, asymmetric so no rotation maps it onto itself), each at
/// a different yaw and position, under an `IfcSite` translated to
/// building-scale coordinates and yawed 34 degrees: the `site_local` tier,
/// whose baked frame is not the frame the instancing metadata describes.
fn rotated_repeats_ifc(n: usize) -> String {
    let site_yaw = 34f64.to_radians();
    let mut out = format!(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('5407 cross-batch shared shapes'),'2;1');
FILE_NAME('x5407.ifc','2026-09-24T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#3=IFCUNITASSIGNMENT((#1,#2));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-06,#5,$);
#7=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#6,$,.MODEL_VIEW.,$);
#8=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#6),#3);
#30=IFCCARTESIANPOINT((1500.,-2400.,12.));
#31=IFCDIRECTION((0.,0.,1.));
#32=IFCDIRECTION(({c:.6},{s:.6},0.));
#33=IFCAXIS2PLACEMENT3D(#30,#31,#32);
#34=IFCLOCALPLACEMENT($,#33);
#35=IFCSITE('1s1tEAnIV5BixApwp1Yzp0',$,'site',$,$,#34,$,$,.ELEMENT.,$,$,$,$,$);
#10=IFCCARTESIANPOINT((0.,0.));
#11=IFCCARTESIANPOINT((4.,0.));
#12=IFCCARTESIANPOINT((4.,1.));
#13=IFCCARTESIANPOINT((1.,1.));
#14=IFCCARTESIANPOINT((1.,3.));
#15=IFCCARTESIANPOINT((0.,3.));
#16=IFCPOLYLINE((#10,#11,#12,#13,#14,#15,#10));
#17=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#16);
#18=IFCEXTRUDEDAREASOLID(#17,#5,#31,2.);
#19=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#18));
#20=IFCREPRESENTATIONMAP(#5,#19);
#21=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,$,$);
"#,
        c = site_yaw.cos(),
        s = site_yaw.sin(),
    );
    for k in 0..n {
        let yaw = (40.0 * k as f64).to_radians();
        let id = 100 + 10 * k;
        out.push_str(&format!(
            "#{a}=IFCMAPPEDITEM(#20,#21);\n\
             #{b}=IFCSHAPEREPRESENTATION(#7,'Body','MappedRepresentation',(#{a}));\n\
             #{p}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{b}));\n\
             #{pt}=IFCCARTESIANPOINT(({x}.,{y}.,0.));\n\
             #{dir}=IFCDIRECTION(({c:.6},{s:.6},0.));\n\
             #{ax}=IFCAXIS2PLACEMENT3D(#{pt},#31,#{dir});\n\
             #{lp}=IFCLOCALPLACEMENT(#34,#{ax});\n\
             #{e}=IFCBUILDINGELEMENTPROXY('0Proxy{k:016}',$,'p{k}',$,$,#{lp},#{p},$,$);\n",
            a = id,
            b = id + 1,
            p = id + 2,
            pt = id + 3,
            dir = id + 4,
            ax = id + 5,
            lp = id + 6,
            e = id + 7,
            x = 8 * k,
            y = 3 * k,
            c = yaw.cos(),
            s = yaw.sin(),
        ));
    }
    out.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    out
}

/// A state whose route emits two meshes per batch, so the fixture's repeats
/// land in different batches.
async fn two_per_batch_state(label: &str) -> AppState {
    let mut state = test_state(label).await;
    let mut config = (*state.config).clone();
    config.initial_batch_size = 2;
    config.max_batch_size = 2;
    state.config = Arc::new(config);
    state
}

async fn stream_with(state: &AppState, content: &str, query: &str) -> (StatusCode, Vec<Value>) {
    let (content_type, body) = multipart_body(content.as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/parse/parquet-stream{query}"))
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .unwrap();
    let response = build_router(state.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        to_bytes(response.into_body(), usize::MAX),
    )
    .await
    .expect("SSE stream should finish")
    .unwrap();
    if status != StatusCode::OK {
        return (status, Vec::new());
    }
    (status, parse_sse_events(std::str::from_utf8(&bytes).unwrap()))
}

fn batches(events: &[Value]) -> Vec<&Value> {
    events.iter().filter(|e| e["type"] == "batch").collect()
}

/// The three sections of one batch blob.
fn sections(blob: &[u8]) -> [RecordBatch; 3] {
    let mut off = 0;
    std::array::from_fn(|_| {
        let len = u32::from_le_bytes(blob[off..off + 4].try_into().unwrap()) as usize;
        let bytes = bytes::Bytes::copy_from_slice(&blob[off + 4..off + 4 + len]);
        off += 4 + len;
        // A batch whose every row points back carries an EMPTY vertex table,
        // which reads as zero record batches, so take the schema up front.
        let builder = ParquetRecordBatchReaderBuilder::try_new(bytes).unwrap();
        let schema = builder.schema().clone();
        let parts: Vec<RecordBatch> = builder.build().unwrap().map(|b| b.unwrap()).collect();
        arrow::compute::concat_batches(&schema, &parts).unwrap()
    })
}

fn col<A: Array + Clone + 'static>(batch: &RecordBatch, name: &str) -> A {
    let idx = batch.schema().index_of(name).unwrap_or_else(|_| panic!("missing column {name}"));
    batch.column(idx).as_any().downcast_ref::<A>().unwrap().clone()
}

/// What a client reconstructs from one stream: every mesh's world vertices
/// (`origin + R * p`), keyed by express id, plus the vertex rows it received.
///
/// Decodes the way each mode's client must. A batch that states
/// `vertex_base` indexes the vertex rows of the WHOLE stream so far, and its
/// base must equal what the client has received; a batch that does not is
/// decoded on its own.
fn reconstruct(events: &[Value]) -> (std::collections::BTreeMap<u32, Vec<[f64; 3]>>, usize) {
    let mut store: Vec<[f64; 3]> = Vec::new();
    let mut indices_received = 0u64;
    let mut world = std::collections::BTreeMap::new();
    for batch in batches(events) {
        let blob = STANDARD.decode(batch["data"].as_str().unwrap()).unwrap();
        let [mesh, vertex, index] = sections(&blob);
        let (x, y, z) = (
            col::<Float32Array>(&vertex, "x"),
            col::<Float32Array>(&vertex, "y"),
            col::<Float32Array>(&vertex, "z"),
        );
        let rows = (0..vertex.num_rows()).map(|i| [x.value(i) as f64, y.value(i) as f64, z.value(i) as f64]);
        let base = match batch.get("vertex_base") {
            Some(base) => {
                assert_eq!(base.as_u64().unwrap(), store.len() as u64, "vertex_base must be what the client holds");
                assert_eq!(
                    batch["index_base"].as_u64().unwrap(),
                    indices_received,
                    "index_base must be what the client holds, in indices"
                );
                0
            }
            None => {
                // Batch-local: this batch's vertex table is its own world.
                store.clear();
                0
            }
        };
        let _ = base;
        store.extend(rows);
        indices_received += 3 * index.num_rows() as u64;
        let (ids, starts, counts) = (
            col::<UInt32Array>(&mesh, "express_id"),
            col::<UInt32Array>(&mesh, "vertex_start"),
            col::<UInt32Array>(&mesh, "vertex_count"),
        );
        let (ox, oy, oz) = (
            col::<Float64Array>(&mesh, "origin_x"),
            col::<Float64Array>(&mesh, "origin_y"),
            col::<Float64Array>(&mesh, "origin_z"),
        );
        let rot: Vec<Float32Array> = (0..9).map(|i| col::<Float32Array>(&mesh, &format!("rot{i}"))).collect();
        for row in 0..mesh.num_rows() {
            let r: Vec<f64> = rot.iter().map(|c| c.value(row) as f64).collect();
            let o = [ox.value(row), oy.value(row), oz.value(row)];
            let start = starts.value(row) as usize;
            let verts = store[start..start + counts.value(row) as usize]
                .iter()
                .map(|p| {
                    [
                        o[0] + r[0] * p[0] + r[1] * p[1] + r[2] * p[2],
                        o[1] + r[3] * p[0] + r[4] * p[1] + r[5] * p[2],
                        o[2] + r[6] * p[0] + r[7] * p[1] + r[8] * p[2],
                    ]
                })
                .collect();
            assert!(world.insert(ids.value(row), verts).is_none(), "one mesh per proxy");
        }
    }
    let received = batches(events)
        .iter()
        .map(|b| sections(&STANDARD.decode(b["data"].as_str().unwrap()).unwrap())[1].num_rows())
        .sum();
    (world, received)
}

fn assert_same_world(
    actual: &std::collections::BTreeMap<u32, Vec<[f64; 3]>>,
    expected: &std::collections::BTreeMap<u32, Vec<[f64; 3]>>,
) {
    assert_eq!(actual.keys().collect::<Vec<_>>(), expected.keys().collect::<Vec<_>>());
    for (id, verts) in expected {
        let got = &actual[id];
        assert_eq!(got.len(), verts.len(), "mesh #{id} vertex count");
        for (v, (a, e)) in got.iter().zip(verts).enumerate() {
            for axis in 0..3 {
                assert!(
                    (a[axis] - e[axis]).abs() < 1e-3,
                    "mesh #{id} vertex {v} axis {axis}: {a:?} vs {e:?}"
                );
            }
        }
    }
}

/// The feature itself: rotated repeats streamed across batches share ONE
/// block, and every occurrence still lands where the batch-local stream puts
/// it.
#[tokio::test]
async fn cross_batch_stream_shares_rotated_repeats_across_batches() {
    const N: usize = 6;
    let ifc = rotated_repeats_ifc(N);

    let (_, local) = stream_with(&two_per_batch_state("x5407-local").await, &ifc, SHARED).await;
    let (_, shared) = stream_with(&two_per_batch_state("x5407-shared").await, &ifc, CROSS_BATCH).await;

    // The fixture must actually span batches, or nothing here is cross-batch.
    assert!(batches(&local).len() >= 3, "fixture must stream in several batches");
    assert_eq!(batches(&shared).len(), batches(&local).len());

    // The opt-in is acknowledged on every batch, and ONLY when asked for:
    // a batch-local client must never see a base it does not understand.
    assert!(batches(&shared).iter().all(|b| b.get("vertex_base").is_some() && b.get("index_base").is_some()));
    assert!(batches(&local).iter().all(|b| b.get("vertex_base").is_none() && b.get("index_base").is_none()));

    let (local_world, local_rows) = reconstruct(&local);
    let (shared_world, shared_rows) = reconstruct(&shared);
    assert_eq!(local_world.len(), N);
    assert_same_world(&shared_world, &local_world);

    // One L-shape's worth of vertices for the whole stream, not one per batch.
    let per_shape = local_rows / N;
    assert_eq!(
        shared_rows, per_shape,
        "every later occurrence must point back at the first batch's block \
         ({local_rows} batch-local vertex rows for {N} occurrences)"
    );
    for later in &batches(&shared)[1..] {
        let blob = STANDARD.decode(later["data"].as_str().unwrap()).unwrap();
        assert_eq!(sections(&blob)[1].num_rows(), 0, "a later batch re-sent the shape");
    }
}

/// Cross-batch sharing needs the rotation columns to place anything, and the
/// flat layout must stay byte-identical to v5, so asking for both is refused
/// rather than silently answered batch-locally.
#[tokio::test]
async fn cross_batch_on_the_flat_layout_is_a_bad_request() {
    let state = two_per_batch_state("x5407-flat").await;
    let (status, _) = stream_with(&state, &rotated_repeats_ifc(2), "?stream_shapes=cross-batch").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// Both modes fill ONE cache entry, and a hit must replay correctly to either
/// kind of client: a cross-batch one gets the row groups as written, bases and
/// all; a batch-local one cannot be handed back-references, so it gets the
/// whole blob as a single self-contained batch.
#[tokio::test]
async fn a_cross_batch_cache_entry_replays_to_both_kinds_of_client() {
    let ifc = rotated_repeats_ifc(6);
    let state = two_per_batch_state("x5407-replay").await;
    let (_, live) = stream_with(&state, &ifc, CROSS_BATCH).await;
    await_cache_fill_for(&state, &live, ParquetLayout::SharedShapes).await;

    let (live_world, live_rows) = reconstruct(&live);

    let (_, cross_replay) = stream_with(&state, &ifc, CROSS_BATCH).await;
    assert_eq!(batches(&cross_replay).len(), batches(&live).len(), "replay stays progressive");
    let (world, rows) = reconstruct(&cross_replay);
    assert_same_world(&world, &live_world);
    assert_eq!(rows, live_rows);

    let (_, local_replay) = stream_with(&state, &ifc, SHARED).await;
    assert_eq!(batches(&local_replay).len(), 1, "back-references cannot be re-based batch-locally");
    assert!(batches(&local_replay)[0].get("vertex_base").is_none());
    let (world, _) = reconstruct(&local_replay);
    assert_same_world(&world, &live_world);
}

/// Writes the two SSE captures `packages/server-client` decodes through its
/// real stream reader and parquet-wasm (`parquet-stream-shapes.decode.test.ts`):
/// the fixture above streamed batch-locally and cross-batch. Ignored because it
/// WRITES; rerun it whenever the wire changes:
///
/// `cargo test -p ifc-lite-server write_server_client_stream_fixtures -- --ignored`
#[tokio::test]
#[ignore]
async fn write_server_client_stream_fixtures() {
    let ifc = rotated_repeats_ifc(6);
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/server-client/src/__fixtures__");
    for (name, query) in [("stream-batch-local.sse", SHARED), ("stream-cross-batch.sse", CROSS_BATCH)] {
        let (_, events) = stream_with(&two_per_batch_state(&format!("x5407-{name}")).await, &ifc, query).await;
        let sse: String = events.iter().map(|e| format!("data: {e}\n\n")).collect();
        std::fs::write(dir.join(name), sse).unwrap();
    }
}
