// SPDX-License-Identifier: MPL-2.0
use super::*;

fn caches() -> RouterCaches {
    RouterCaches {
        items: GeometryRouter::new_dedup_cache(),
        brep_signatures: GeometryRouter::new_brep_signature_cache(),
        mapped_items: GeometryRouter::new_mapped_item_cache(),
    }
}

#[test]
fn c4_10b_decode_policy_preserves_warm_span_and_scanned_keyword_7782() {
    let source = b"#1=IFCWALL('wall',$,$,$,$,$,$,$,$);";
    let span = JobSpan {
        id: 1,
        start: 0,
        end: source.len(),
    };
    let mut decoder = EntityDecoder::new(source);
    let entity = decode_job(&mut decoder, span, ExecutionPolicy::PerBatch).unwrap();
    let invalid_span = JobSpan {
        start: usize::MAX,
        end: usize::MAX,
        ..span
    };
    let warm = decode_job(&mut decoder, invalid_span, ExecutionPolicy::PerBatch).unwrap();
    assert_eq!(entity.attributes, warm.attributes);
    assert!(decode_job(&mut decoder, invalid_span, ExecutionPolicy::PerJob).is_err());
    assert_eq!(job_type(&entity, source, span, None), IfcType::IfcWall);
    assert_eq!(
        job_type(&entity, source, invalid_span, Some(&IfcType::IfcSlab)),
        IfcType::IfcSlab
    );
    assert_eq!(job_type(&warm, source, invalid_span, None), warm.ifc_type);
}

#[test]
fn c4_10b_builder_preserves_rtc_quality_and_unit_refusal_7782() {
    let config = RouterConfig {
        unit_scale: 0.001,
        rtc_offset: (100.0, 200.0, 300.0),
        skip_small_cuts: true,
        tessellation_quality: ifc_lite_geometry::TessellationQuality::High,
        ..Default::default()
    };
    let router = build_router(
        config.clone(),
        ExecutionPolicy::PerBatch,
        &caches(),
        None,
        None,
        None,
    );
    assert_eq!(router.config(), &config);
    let refused = build_router(
        RouterConfig {
            unit_scale: f64::NAN,
            ..config
        },
        ExecutionPolicy::PerJob,
        &caches(),
        None,
        None,
        None,
    );
    assert!(refused.length_unit_refused());
}
