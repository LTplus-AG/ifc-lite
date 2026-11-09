// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
#[path = "../examples/compare/metrics.rs"]
#[allow(dead_code)]
mod metrics;
use ifc_lite_core::{SourceBundle, EntityDecoder, build_entity_index};
use ifc_lite_retained_native::{NativeModelDriver, ModelOptions, ProductOutcome, oracle::{convex, retrace}};
const FIXTURE: &str = include_str!("../../processing/tests/fixtures/issue_3641_voiding_trap.ifc");
fn tolerances() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/tolerances.d/m8.json")).unwrap()
}
fn worker() -> Option<NativeModelDriver> {
    let path = std::env::var_os("IFCLITE_SMLIB_WORKER");
    if path.is_none() {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "M8 requires the real SDK worker");
        eprintln!("SKIP M8 real SDK: IFCLITE_SMLIB_WORKER absent; not qualification");
    }
    path.map(NativeModelDriver::new)
}
#[test]
fn issue_3641_real_sdk_cutpart_and_opening_subset_matrix() {
    let Some(mut driver) = worker() else { return };
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(FIXTURE.as_bytes(), None);
    let frame = sources.extrusion_definitions.instances[&72209][0].world_from_source.unwrap();
    let origin = [frame[12],frame[13],frame[14]];
    let mut decoder = EntityDecoder::with_index(FIXTURE.as_bytes(),build_entity_index(FIXTURE.as_bytes()));
    let expected = retrace::source(&sources,&mut decoder,origin,1e-12).unwrap();
    let host = convex::source(&sources,72209,origin).unwrap();
    let cutters = [convex::source(&sources,72216,origin).unwrap(),convex::source(&sources,72230,origin).unwrap(),expected.clone()];
    let t = tolerances();
    let mut refused = Vec::new();
    for mask in 0u32..8 {
        let text = FIXTURE.lines().filter(|line| ![(0,"#72208="),(1,"#72229="),(2,"#72244=")].iter()
            .any(|(i,prefix)| mask & (1<<i) == 0 && line.starts_with(prefix))).collect::<Vec<_>>().join("\n");
        let mut measured = Vec::new();
        let (summary,timing) = driver.run_model(SourceBundle::new(text.into_bytes()),&ModelOptions::default(), |outcome,_| {
            match outcome {
                ProductOutcome::Published(product) => {
                    let mut m = metrics::Metrics::default();
                    for part in &product.parts {
                        let mut frame = part.world_from_object;
                        for k in 0..3 { frame[12+k] -= origin[k]; }
                        let points: Vec<_> = part.positions.chunks_exact(3).map(|p| metrics::transform(&frame,[p[0],p[1],p[2]])).collect();
                        m.add_mesh(&points,&part.indices).unwrap();
                    }
                    assert_eq!(m.defects,0,"product {}",product.product_id);
                    measured.push((product.product_id,"published".to_string(),Some(m.volume),Some(product.cuts)));
                    if product.product_id == 72245 { assert!((m.volume-expected.volume()).abs()/expected.volume()<=t["convexLeafVolumeRelative"]["linear"].as_f64().unwrap()); }
                    if product.product_id == 72209 {
                        let selected: Vec<_> = cutters.iter().enumerate().filter(|(i,_)| mask & (1<<i) != 0).map(|(_,c)| c.clone()).collect();
                        let volume = convex::difference_volume(&host,&selected).unwrap();
                        let relative = (m.volume-volume).abs()/volume;
                        eprintln!("M8 slab mask={mask}: volume={} oracle={volume} relative={relative} cuts={} cutTimesMs={:?}", m.volume, product.cuts, product.cut_times_ms);
                        assert!(relative<=t["convexDifferenceVolumeRelative"]["linear"].as_f64().unwrap());
                        assert_eq!(product.cuts, u64::from(mask.count_ones()));
                        assert_eq!(product.cut_times_ms.len(), mask.count_ones() as usize);
                        assert!(product.cut_times_ms.iter().all(|ms| ms.is_finite() && *ms >= 0.));
                        let bbox = host.bbox();
                        let extent = (0..3).map(|i| bbox[i+3]-bbox[i]).fold(0., f64::max);
                        let limit = t["voidingResultBboxWithinHost"]["absolute"].as_f64().unwrap()
                            + extent*t["voidingResultBboxWithinHost"]["extentFactor"].as_f64().unwrap();
                        assert!(ifc_lite_retained_native::oracle::openings::bbox_excess(&m.bbox, &bbox)<=limit);
                    }
                }
                ProductOutcome::Refused {product_id,refusal,origin,message,cut_times_ms,..} => {
                    eprintln!("M8 refusal mask={mask} product={product_id} code={} origin={origin:?} message={message:?} cutTimesMs={cut_times_ms:?}", refusal.code());
                    refused.push((mask,product_id,refusal.code().to_string()));
                    measured.push((product_id,refusal.code().into(),None,None));
                }
            }
        }).unwrap();
        assert_eq!(summary.candidates,4);
        assert_eq!(summary.published + summary.by_code.values().sum::<usize>(), 4);
        if mask == 7 {
            if let Some(path) = std::env::var_os("IFCLITE_M8_NATIVE_REFERENCE") {
                let rows: Vec<_> = measured.iter().map(|(id,code,volume,cuts)| serde_json::json!({"id":id,"code":code,"volume":volume,"cuts":cuts})).collect();
                std::fs::write(path,serde_json::to_vec_pretty(&rows).unwrap()).unwrap();
            }
        }
        eprintln!("sdk witness executed: m8 issue_3641 mask={mask} codes_volumes={measured:?} timings={timing:?}");
    }
    assert!(refused.is_empty(), "M3-A + M8 requires all opening subsets to publish: {refused:?}");
    println!("sdk witness executed: m8 issue_3641 opening subset matrix");
}
