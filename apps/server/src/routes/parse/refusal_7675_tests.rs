// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A data model refused by the streamed fill (#7675: material rows over their
//! budget) is reported, not dropped: the fill used to discard the refusal, so
//! `GET /parse/data-model` answered the terminal 404 instead of the reason.

use super::*;
use std::time::Duration;

/// One layer set listing one layer 1 000 times, related to 1 000 elements:
/// 1 000 000 material rows from 8 KB, over the material table's budget.
fn elements_times_layers_ifc() -> String {
    let layers = vec!["#3"; 1_000].join(",");
    let elements: Vec<String> = (0..1_000).map(|i| format!("#{}", 100 + i)).collect();
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
         #2=IFCMATERIAL('Concrete',$,$);\n\
         #3=IFCMATERIALLAYER(#2,0.1,$,'Core',$,$,$);\n\
         #4=IFCMATERIALLAYERSET(({layers}),'Wall',$);\n\
         #5=IFCRELASSOCIATESMATERIAL('Rel0000000000000007675',$,$,$,({}),#4);\n\
         ENDSEC;\nEND-ISO-10303-21;\n",
        elements.join(",")
    )
}

#[tokio::test]
async fn a_refused_streamed_data_model_is_fetched_as_400_with_its_reason() {
    let state = test_state("7675-stream-refusal").await;
    let ifc = elements_times_layers_ifc();
    let key = format!("{}-default", DiskCache::generate_key(ifc.as_bytes()));
    let (content_type, body) = multipart_body(ifc.as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/parse/parquet-stream")
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .unwrap();
    let response = build_router(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    to_bytes(response.into_body(), usize::MAX).await.unwrap();

    let uri = format!("/api/v1/parse/data-model/{key}");
    for _ in 0..400 {
        let request = Request::builder().method("GET").uri(&uri).body(Body::empty()).unwrap();
        let response = build_router(state.clone()).oneshot(request).await.unwrap();
        match response.status() {
            StatusCode::ACCEPTED | StatusCode::SERVICE_UNAVAILABLE => tokio::time::sleep(Duration::from_millis(25)).await,
            StatusCode::BAD_REQUEST => {
                let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                let text = String::from_utf8_lossy(&body);
                assert!(text.contains("material associations exceed"), "{text}");
                return;
            }
            other => panic!("GET {uri} answered {other}, not the refusal"),
        }
    }
    panic!("the refusal was never reported after 10 s");
}
