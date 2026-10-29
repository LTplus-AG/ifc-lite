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
    assert!(Arc::ptr_eq(&entity.attributes, &warm.attributes));
    assert!(decode_job(&mut decoder, invalid_span, ExecutionPolicy::PerJob).is_err());
    assert_eq!(job_type(&entity, source, span, None), IfcType::IfcWall);
    assert_eq!(
        job_type(&entity, source, invalid_span, Some(&IfcType::IfcSlab)),
        IfcType::IfcSlab
    );
    assert_eq!(job_type(&warm, source, invalid_span, None), warm.ifc_type);
}

// Actual mesh-frame invariant: rebasing changes local coordinates, while
// reconstructing world bounds and hashing with the applied RTC stays identical.
#[test]
fn c4_10b_builder_preserves_mesh_world_frame_and_unit_refusal_7782() {
    use crate::element::*;
    let source = include_str!("../tests/fixtures/c4_0_refusal_parity_7782.ifc");
    let run = |rtc: [f64; 3], scale: f64| {
        let mut decoder = EntityDecoder::new(source).with_strict_reals();
        decoder.seed_unit_scales(scale, 1.0);
        let entity = decoder.decode_by_id(300).unwrap();
        let router = build_router(
            RouterConfig {
                unit_scale: scale,
                rtc_offset: (rtc[0], rtc[1], rtc[2]),
                ..Default::default()
            },
            ExecutionPolicy::PerBatch,
            &caches(),
            None,
            None,
            None,
        );
        produce_element_meshes_owned(
            &ElementMeshJob {
                id: 300,
                ifc_type: entity.ifc_type.clone(),
                entity: &entity,
                kind: ElementJobKind::Product,
                element_color: None,
                metadata: None,
            },
            &ProductionModel::new().snapshot(Default::default()),
            &MeshProductionOptions {
                geometry_hash: Some(GeometryHashConfig {
                    tolerance: 1e-5,
                    world_rtc: rtc,
                }),
                ..Default::default()
            },
            &mut decoder,
            &router,
        )
        .unwrap()
    };
    let world = run([0.0; 3], 1.0);
    let shifted = run([100.0, 200.0, 300.0], 1.0);
    assert!(!world.meshes.is_empty());
    assert_eq!(world.geometry_hash, shifted.geometry_hash);
    assert_eq!(world.geometry_aabb, shifted.geometry_aabb);
    assert_ne!(world.meshes[0].origin, shifted.meshes[0].origin);
    assert!(run([0.0; 3], f64::NAN).meshes.is_empty());
}
